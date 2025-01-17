import fs from "fs";
import path from "path";
import execa from "execa";
import * as rokuDeploy from "roku-deploy";
import {RokuClient} from "roku-client";
import net from "net";
import * as uuid from "uuid";
import ADLER32 from "adler-32";
import mkdirp from "mkdirp";
import rimraf from "rimraf";
import * as brighterscript from "brighterscript";

interface WastArg {
  type: "i32" | "i64" | "f32" | "f64";
  value: string;
}

interface WastActionInvoke {
  type: "invoke";
  module?: string;
  field: string;
  args: WastArg[]
}

interface WastActionGet {
  type: "get";
}

interface WastCommand {
  type: string;
  line: number;
  jsonLine: number;
}

interface WastModuleCommand extends WastCommand {
  type: "module";
  filename: string;
  name?: string;
}

interface WastActionCommand extends WastCommand {
  type: "action";
  action: WastActionInvoke,
}

interface WastAssertReturnCommand extends WastCommand {
  type: "assert_return";
  action: WastActionInvoke | WastActionGet,
  filename: string;
  expected: WastArg[];
}

interface WastJson {
  commands: (WastModuleCommand | WastActionCommand | WastAssertReturnCommand)[];
}

type WastTestCommand = WastAssertReturnCommand | WastActionCommand;

interface WastTest {
  module: WastModuleCommand;
  commands: WastTestCommand[];
}

// Basic arg parsing (replace this with something better)
const args: Record<string, string> = {};
const slicedArgv = process.argv.slice(2);
for (let i = 0; i < slicedArgv.length; i += 2) {
  args[slicedArgv[i]] = slicedArgv[i + 1];
}

const root = path.join(__dirname, "../..");
const runtestOut = path.join(root, "build/run_test");
const rokuDeployOut = path.join(root, "build/roku_deploy");
const project = path.join(root, "project");
const projectSource = path.join(project, "source");
const testCasesBrs = path.join(projectSource, "test-cases.out.brs");
const testWasmBrs = path.join(projectSource, "test-wasm.out.brs");
const testSuiteDir = path.join(root, "third_party/testsuite");
const wasm2brs = path.join(root, "build/wasm2brs/wasm2brs");

const outputWastTests = async (wastFile: string, guid: string): Promise<boolean | string> => {
  const testWast = path.resolve(wastFile);
  const testWastFilename = path.basename(wastFile);
  console.log("Outputting for", testWastFilename);

  const fromRootOptions: execa.Options = {
    cwd: root,
    stdio: "pipe",
    reject: false
  };

  rimraf.sync(runtestOut);
  await mkdirp(runtestOut);

  const outJsonFilename = "current.json";
  const outJson = path.join(runtestOut, outJsonFilename);
  const wast2Json = await execa("third_party/wabt/bin/wast2json",
    [
      "--disable-multi-value",
      testWast,
      "-o", outJson
    ],
    fromRootOptions);

  if (wast2Json.stderr) {
    console.error(wast2Json.stderr);
    return wast2Json.stderr.split("\n")[0];
  }

  const wastJson = JSON.parse(fs.readFileSync(outJson, "utf8")) as WastJson;

  // Group all the commands under the module they belong to.
  let currentTest: WastTest = null;
  // The commands start at this line in the json output by wast2json.
  let currentJsonLine = 3;
  const tests: WastTest[] = [];
  for (const command of wastJson.commands) {
    if (command.type === "module") {
      currentTest = {
        module: command,
        commands: []
      };
      tests.push(currentTest);
    } else if (command.type === "action" || command.type === "assert_return" && command.action.type === "invoke") {
      command.jsonLine = currentJsonLine;
      currentTest.commands.push(command);
    }
    ++currentJsonLine;
  }

  // Only skip wast files that have no commands for all tests.
  if (tests.every((test) => test.commands.length === 0)) {
    return false;
  }

  const floatNanBrs = "FloatNan()";
  const floatInfBrs = "FloatInf()";
  const floatNegativeZeroBrs = "FloatNegativeZero()";
  const doubleNanBrs = "DoubleNan()";
  const doubleInfBrs = "DoubleInf()";
  const doubleNegativeZeroBrs = "DoubleNegativeZero()";
  const toArgValue = (arg: WastArg) => {
    if (arg.type === "i32" || arg.type === "i64") {
      return arg.value + (arg.type === "i32" ? "%" : "&");
    }

    // TODO(trevor): Differentiate between nan:canonical and nan:arithmetic (find a way in BrightScript)
    if (arg.value === "nan:canonical" || arg.value === "nan:arithmetic") {
      return arg.type === "f32" ? floatNanBrs : doubleNanBrs;
    }

    const buffer = new ArrayBuffer(8);
    const view = new DataView(buffer);
    const value = (() => {
      if (arg.type === "f32") {
        view.setUint32(0, parseInt(arg.value, 10), true);
        return view.getFloat32(0, true);
      }
      view.setBigUint64(0, BigInt(arg.value), true);
      return view.getFloat64(0, true);
    })();

    const isNegativeZero = value === 0 && 1 / value === -Infinity;
    if (isNegativeZero) {
      return arg.type === "f32" ? floatNegativeZeroBrs : doubleNegativeZeroBrs;
    }
    const str = value.toString();
    if (str === "Infinity") {
      return arg.type === "f32" ? floatInfBrs : doubleInfBrs;
    }
    if (str === "-Infinity") {
      return arg.type === "f32" ? `-${floatInfBrs}` : `-${doubleInfBrs}`;
    }
    if (str === "NaN") {
      const signByte = arg.type === "f32" ? view.getUint8(3) : view.getUint8(7);
      const isSignBitSet = signByte >= 128;
      return `${isSignBitSet ? "-" : ""}${arg.type === "f32" ? floatNanBrs : doubleNanBrs}`;
    }
    return str + (arg.type === "f32" ? "!" : "#");
  };

  const adler32 = (name: string) => {
    const result = ADLER32.str(name);
    return result < 0 ? result + 4294967296 : result;
  };

  let testCasesFile = "";
  let testWasmFile = "";

  let runTestsFunction = "Function Start()\n";

  console.log("Number of modules:", tests.length);
  for (const [textIndex, test] of tests.entries()) {
    // Should match LegalizeName / LegalizeNameNoAddons
    const legalizeNameNoAddons = (name: string) => name.replace(/[^a-zA-Z0-9]/gu, "_").toLowerCase();
    const legalizeName = (module: string, name: string) => {
      const legalized = legalizeNameNoAddons(name);
      const output = `${legalizeNameNoAddons(module)}_${legalized}`;
      return legalized === name
        ? output
        : `${output}_${adler32(name)}`;
    };

    const moduleName = test.module.name ? legalizeNameNoAddons(test.module.name) : `Test${textIndex}`;
    console.log("Outputting module", test.module.filename);
    const wasm2BrsResult = await execa(wasm2brs,
      [
        "--name-prefix", moduleName,
        path.join(runtestOut, test.module.filename)
      ],
      fromRootOptions);

    if (wasm2BrsResult.exitCode !== 0) {
      return wasm2BrsResult.stderr || `Code ${wasm2BrsResult.exitCode || wasm2BrsResult.signal}`;
    }
    testWasmFile += `${wasm2BrsResult.stdout}\n`;

    const sourceMapNewline = (command: WastCommand) =>
      `' ${testWastFilename}(${command.line}) ${outJsonFilename}(${command.jsonLine})\n`;

    let testFunction =
      `Function ${moduleName}()\n` +
      `  ${moduleName}Init__() ${sourceMapNewline(test.module)}`;

    const writeInvoke = (command: WastTestCommand, invoke: WastActionInvoke) => {
      const param = invoke.args.map((arg) => toArgValue(arg)).join(",");
      testFunction +=
        `  result = ${legalizeName(invoke.module || moduleName, invoke.field)}(${param}) ${sourceMapNewline(command)}`;
    };

    for (const command of test.commands) {
      switch (command.type) {
        case "assert_return": {
          if (command.action.type === "invoke") {
            writeInvoke(command, command.action);
            for (const [index, arg] of command.expected.entries()) {
              const expected = toArgValue(arg);
              testFunction += `  AssertEquals(${command.expected.length === 1
                ? "result"
                : `result[${index}]`
              }, ${expected})\n`;
            }
          }
          break;
        }
        case "action": {
          writeInvoke(command, command.action);
          break;
        }
      }
    }
    testFunction += "End Function\n";
    runTestsFunction += `  ${moduleName}()\n`;
    testCasesFile += testFunction;
  }
  runTestsFunction += "End Function\n";
  testCasesFile += runTestsFunction;

  testCasesFile += "Function GetSettings()\n" +
    "Return { CustomInit: InitSpectest }\n" +
  "End Function";

  fs.writeFileSync(testCasesBrs, testCasesFile);
  fs.writeFileSync(testWasmBrs, testWasmFile);

  fs.writeFileSync(path.join(project, "manifest"),
    `title=${guid}`
  );
  return true;
};

const deploy = async (guid: string, host: string): Promise<true | string> => {
  console.log("Deploying...");
  try {
    await rokuDeploy.deploy({
      host,
      password: args.password || "rokudev",
      rootDir: project,
      outDir: rokuDeployOut,
      failOnCompileError: true
    });
  } catch {
    console.error("Failed to deploy. Connecting to see the error...");
  }

  let result: true | string = true;

  console.log("Connecting...");
  await new Promise<void>((resolve) => {
    let str = "";
    let writeOutput = false;
    const socket = net.connect(8085, host);
    socket.on("data", (buffer) => {
      const text = buffer.toString();
      str += text;
      if (writeOutput) {
        process.stdout.write(text);
      } else {
        const index = str.indexOf(`------ Compiling dev '${guid}' ------`);
        if (index !== -1) {
          str = str.substr(index);
          process.stdout.write(str);
          writeOutput = true;
        }
        if (str.indexOf("Console connection is already in use.") !== -1) {
          throw new Error("Telnet connection already in use, please stop debugger to see result");
        }
      }

      const end = () => {
        process.stdout.write("\n");
        socket.destroy();
        resolve();
      };

      if (writeOutput) {
        if (str.indexOf("------ Completed ------") !== -1) {
          end();
          return;
        }
        const match = str.match(/Syntax Error.*|.*runtime error.*/u) || str.match(/ERROR compiling.*/u);
        if (match) {
          const [error] = match;
          const testCasesLineRegex = /pkg:\/source\/test-cases.out.brs\(([0-9]+)\)/u;
          const testCasesMatch = str.match(testCasesLineRegex);
          if (testCasesMatch && !error.match(testCasesLineRegex)) {
            result = `${error} : ${testCasesMatch[0]}`;
          } else {
            result = error;
          }
          end();
        }
      }
    });
  });
  return result;
};

const outputAndMaybeDeploy = async (wastFile: string, host?: string): Promise<boolean | string> => {
  const guid = uuid.v4();
  const result = await outputWastTests(wastFile, guid);
  if (result === true) {
    switch (host) {
      case "brighterscript":
        await new brighterscript.ProgramBuilder().run({
          rootDir: project
        });
        break;
      default:
        return deploy(guid, host);
    }
    return false;
  }
  return result;
};

(async () => {
  const host = typeof args.deploy === "undefined"
    ? new URL((await RokuClient.discover()).ip).hostname
    : args.deploy;

  if (args.wast === undefined) {
    const results: string[] = [];
    for (const file of fs.readdirSync(testSuiteDir)) {
      if (path.extname(file) === ".wast" && file !== "names.wast") {
        const result = await outputAndMaybeDeploy(path.join(testSuiteDir, file), host);
        if (typeof result === "string") {
          results.push(`FAIL - ${result} - ${file}`);
        } else if (result === false) {
          results.push(`SKIP - ${file}`);
        } else {
          results.push(`PASS - ${file}`);
        }
      }
    }
    console.log(results.sort().join("\n"));
  } else {
    const wastFile = path.resolve(testSuiteDir, args.wast);
    const result = await outputAndMaybeDeploy(wastFile, host);
    if (typeof result === "string") {
      console.error(`ERROR: ${result}`);
    }
  }
})();
