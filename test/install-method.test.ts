import { describe, expect, it } from "vitest";
import { installMethod, pathFix, reinstallCommand, upgradeCommand, type InstallMethod } from "../src/install-method.js";

// A realpath that follows the links in `links` (path -> target) and returns anything else unchanged.
const follows =
  (links: Record<string, string> = {}) =>
  (path: string) =>
    links[path] ?? path;
const fails = () => {
  throw new Error("ENOENT");
};

const mac = (script: string, env: NodeJS.ProcessEnv = {}, realpath = follows()) => installMethod(script, env, "darwin", realpath);
const linux = (script: string, env: NodeJS.ProcessEnv = {}, realpath = follows()) => installMethod(script, env, "linux", realpath);
const win = (script: string, env: NodeJS.ProcessEnv = {}, realpath = follows()) => installMethod(script, env, "win32", realpath);

const WIN_ENV = { USERPROFILE: "C:\\Users\\me", ProgramData: "C:\\ProgramData" };

describe("installMethod: Homebrew", () => {
  it.each([
    "/opt/homebrew/Cellar/cloudpin/1.2.0/libexec/lib/node_modules/cloudpin/dist/cli.js",
    "/usr/local/Cellar/cloudpin/1.2.0/libexec/lib/node_modules/cloudpin/dist/cli.js",
  ])("is brew for a script in a default macOS Cellar's cloudpin keg: %s", (script) => {
    expect(mac(script)).toBe("brew");
  });

  it("is brew on Linux in the default Linuxbrew Cellar", () => {
    expect(linux("/home/linuxbrew/.linuxbrew/Cellar/cloudpin/1.2.0/libexec/lib/node_modules/cloudpin/dist/cli.js")).toBe("brew");
  });

  it("follows the bin/cloudpin symlink into the Cellar (the way brew runs it)", () => {
    const realpath = follows({
      "/opt/homebrew/bin/cloudpin": "/opt/homebrew/Cellar/cloudpin/1.2.0/libexec/lib/node_modules/cloudpin/dist/cli.js",
    });
    expect(mac("/opt/homebrew/bin/cloudpin", {}, realpath)).toBe("brew");
    // Control: the same path without following the link says nothing about brew.
    expect(mac("/opt/homebrew/bin/cloudpin")).toBe("npm");
  });

  it("honours HOMEBREW_CELLAR for a Homebrew in another place", () => {
    const script = "/home/me/.linuxbrew/Cellar/cloudpin/1.2.0/libexec/lib/node_modules/cloudpin/dist/cli.js";
    expect(linux(script)).toBe("npm");
    expect(linux(script, { HOMEBREW_CELLAR: "/home/me/.linuxbrew/Cellar" })).toBe("brew");
    expect(linux(script, { HOMEBREW_CELLAR: "/home/me/.linuxbrew/Cellar/" })).toBe("brew");
  });

  it("stays npm for `npm install --global` with Homebrew's node", () => {
    expect(mac("/opt/homebrew/lib/node_modules/cloudpin/dist/cli.js")).toBe("npm");
    expect(mac("/usr/local/lib/node_modules/cloudpin/dist/cli.js")).toBe("npm");
    expect(linux("/home/linuxbrew/.linuxbrew/lib/node_modules/cloudpin/dist/cli.js")).toBe("npm");
    // Even if the global folder were inside the node keg, it is node's keg, not cloudpin's.
    expect(mac("/opt/homebrew/Cellar/node/24.1.0/lib/node_modules/cloudpin/dist/cli.js")).toBe("npm");
  });

  it("needs the cloudpin keg exactly, not a keg whose name starts with cloudpin", () => {
    expect(mac("/opt/homebrew/Cellar/cloudpin-dev/1.0.0/libexec/lib/node_modules/cloudpin/dist/cli.js")).toBe("npm");
  });

  it("never says brew on Windows", () => {
    expect(win("/opt/homebrew/Cellar/cloudpin/1.2.0/libexec/lib/node_modules/cloudpin/dist/cli.js", WIN_ENV)).toBe("npm");
  });
});

describe("installMethod: Scoop", () => {
  it("is scoop under the default per-user root, in any letter case", () => {
    expect(win("C:\\Users\\me\\scoop\\apps\\cloudpin\\current\\dist\\cli.js", WIN_ENV)).toBe("scoop");
    expect(win("c:\\users\\ME\\Scoop\\Apps\\CloudPin\\1.2.0\\dist\\cli.js", WIN_ENV)).toBe("scoop");
    expect(win("C:/Users/me/scoop/apps/cloudpin/current/dist/cli.js", WIN_ENV)).toBe("scoop");
  });

  it("is scoop under the default global root, SCOOP and SCOOP_GLOBAL", () => {
    expect(win("C:\\ProgramData\\scoop\\apps\\cloudpin\\current\\dist\\cli.js", WIN_ENV)).toBe("scoop");
    expect(win("D:\\tools\\scoop\\apps\\cloudpin\\current\\dist\\cli.js", WIN_ENV)).toBe("npm");
    expect(win("D:\\tools\\scoop\\apps\\cloudpin\\current\\dist\\cli.js", { ...WIN_ENV, SCOOP: "D:\\tools\\scoop" })).toBe("scoop");
    expect(win("E:\\shared\\apps\\cloudpin\\1.2.0\\dist\\cli.js", { ...WIN_ENV, SCOOP_GLOBAL: "E:\\shared\\" })).toBe("scoop");
  });

  it("reads Windows variables in any letter case, as copies of the environment keep them", () => {
    expect(win("C:\\ProgramData\\scoop\\apps\\cloudpin\\current\\dist\\cli.js", { PROGRAMDATA: "C:\\ProgramData" })).toBe("scoop");
    expect(win("D:\\s\\apps\\cloudpin\\current\\dist\\cli.js", { scoop: "D:\\s" })).toBe("scoop");
  });

  it("stays npm for `npm install --global` with Scoop's nodejs-lts", () => {
    expect(win("C:\\Users\\me\\scoop\\apps\\nodejs-lts\\current\\bin\\node_modules\\cloudpin\\dist\\cli.js", WIN_ENV)).toBe("npm");
    expect(win("C:\\Users\\me\\scoop\\persist\\nodejs-lts\\bin\\node_modules\\cloudpin\\dist\\cli.js", WIN_ENV)).toBe("npm");
    expect(win("C:\\Users\\me\\scoop\\apps\\cloudpin-nightly\\current\\dist\\cli.js", WIN_ENV)).toBe("npm");
  });

  it("is scoop for cloudpin's shims, which are files in <root>\\shims, not links (doctor classifies the one on PATH)", () => {
    for (const shim of ["cloudpin.cmd", "cloudpin", "cloudpin.ps1", "cloudpin.exe", "CloudPin.CMD"]) {
      expect(win(`C:\\Users\\me\\scoop\\shims\\${shim}`, WIN_ENV), shim).toBe("scoop");
    }
    expect(win("D:\\s\\shims\\cloudpin.cmd", { SCOOP: "D:\\s" })).toBe("scoop");
    // Controls: another app's shim, a cloudpin outside shims, and a nested folder.
    expect(win("C:\\Users\\me\\scoop\\shims\\node.cmd", WIN_ENV)).toBe("npm");
    expect(win("C:\\Users\\me\\scoop\\shims\\cloudpin-nightly.cmd", WIN_ENV)).toBe("npm");
    expect(win("C:\\Users\\me\\AppData\\Roaming\\npm\\cloudpin.cmd", WIN_ENV)).toBe("npm");
    expect(win("C:\\Users\\me\\scoop\\shims\\x\\cloudpin.cmd", WIN_ENV)).toBe("npm");
  });

  it("stays npm for a plain npm global install and never says scoop off Windows", () => {
    expect(win("C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\cloudpin\\dist\\cli.js", WIN_ENV)).toBe("npm");
    expect(linux("/home/me/scoop/apps/cloudpin/current/dist/cli.js", { SCOOP: "/home/me/scoop" })).toBe("npm");
  });
});

describe("installMethod: a root reached through a link", () => {
  // Fedora Silverblue and Universal Blue: /home is a link to /var/home, so realpath turns /home/... into /var/home/...
  const silverblue = (path: string) => (path === "/home" || path.startsWith("/home/") ? `/var${path}` : path);
  const KEG = "/home/linuxbrew/.linuxbrew/Cellar/cloudpin/1.2.0/libexec/lib/node_modules/cloudpin/dist/cli.js";

  it("is brew when the Linuxbrew Cellar sits under a linked /home", () => {
    expect(silverblue(KEG)).toBe(`/var${KEG}`);
    expect(linux(KEG, {}, silverblue)).toBe("brew");
    expect(linux(KEG, { HOMEBREW_CELLAR: "/home/linuxbrew/.linuxbrew/Cellar" }, silverblue)).toBe("brew");
    // Control: a script under /var/home in another keg is still not cloudpin's.
    expect(linux(KEG.replace("/Cellar/cloudpin/", "/Cellar/node/"), {}, silverblue)).toBe("npm");
  });

  // ~\scoop as a junction to D:\scoop: realpath reports the D: path, matched in any letter case.
  const junction = (path: string) => {
    const from = "c:\\users\\me\\scoop";
    const lower = path.toLowerCase();
    return lower === from || lower.startsWith(`${from}\\`) ? `D:\\scoop${path.slice(from.length)}` : path;
  };

  it("is scoop when the Scoop root is a junction", () => {
    const script = "C:\\Users\\me\\scoop\\apps\\cloudpin\\current\\dist\\cli.js";
    expect(junction(script)).toBe("D:\\scoop\\apps\\cloudpin\\current\\dist\\cli.js");
    expect(win(script, WIN_ENV, junction)).toBe("scoop");
    expect(win(script, { SCOOP: "C:\\Users\\me\\scoop" }, junction)).toBe("scoop");
    // Control: nodejs-lts under the same junction is still npm.
    expect(win(script.replace("\\apps\\cloudpin\\", "\\apps\\nodejs-lts\\"), WIN_ENV, junction)).toBe("npm");
  });
});

describe("installMethod: fallbacks", () => {
  it("uses the unresolved path when realpath fails", () => {
    expect(mac("/opt/homebrew/Cellar/cloudpin/1.2.0/libexec/lib/node_modules/cloudpin/dist/cli.js", {}, fails)).toBe("brew");
    expect(win("C:\\Users\\me\\scoop\\apps\\cloudpin\\current\\dist\\cli.js", WIN_ENV, fails)).toBe("scoop");
    expect(mac("/usr/local/lib/node_modules/cloudpin/dist/cli.js", {}, fails)).toBe("npm");
  });

  it("is npm with no script path at all", () => {
    expect(mac("")).toBe("npm");
    expect(win("", WIN_ENV)).toBe("npm");
  });
});

describe("upgrade advice", () => {
  it.each<[InstallMethod, string, string]>([
    ["brew", "brew upgrade cloudpin", "brew reinstall cloudpin"],
    ["scoop", "scoop update cloudpin", "scoop uninstall cloudpin, then scoop install cloudpin"],
    ["npm", "npm install --global cloudpin", "npm install --global cloudpin"],
  ])("%s: upgrade with %s, reinstall with %s", (method, upgrade, reinstall) => {
    expect(upgradeCommand(method)).toBe(upgrade);
    expect(reinstallCommand(method)).toBe(reinstall);
  });

  it("names the way to put cloudpin back on PATH for each method", () => {
    expect(pathFix("npm")).toBe("npm install --global cloudpin");
    expect(pathFix("brew")).toMatch(/^brew link cloudpin/);
    expect(pathFix("brew")).toContain("PATH");
    expect(pathFix("scoop")).toMatch(/^scoop reset cloudpin/);
    expect(pathFix("scoop")).toContain("PATH");
  });
});
