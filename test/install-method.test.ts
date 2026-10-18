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

// The JavaScript package managers' global folders (#98). Each layout is cited in src/install-method.ts.
const LINUX_ENV = { HOME: "/home/me" };
const MAC_ENV = { HOME: "/Users/me" };
const WIN_PM_ENV = { ...WIN_ENV, LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" };

describe("installMethod: package-manager lookalikes stay npm", () => {
  it("is npm for a project's own node_modules, npx's cache and pnpm dlx's cache", () => {
    expect(linux("/home/me/work/app/node_modules/cloudpin/dist/cli.js", LINUX_ENV)).toBe("npm");
    expect(linux("/home/me/.npm/_npx/1a2b3c4d/node_modules/cloudpin/dist/cli.js", LINUX_ENV)).toBe("npm");
    expect(win("C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\1a2b3c4d\\node_modules\\cloudpin\\dist\\cli.js", WIN_PM_ENV)).toBe("npm");
    expect(linux("/home/me/.cache/pnpm/dlx/abc/1234/node_modules/cloudpin/dist/cli.js", LINUX_ENV)).toBe("npm");
    expect(win("C:\\Users\\me\\AppData\\Local\\pnpm-cache\\dlx\\abc\\1234\\node_modules\\cloudpin\\dist\\cli.js", WIN_PM_ENV)).toBe("npm");
  });

  it("is npm for a project whose packages are links into pnpm's global virtual store", () => {
    const realpath = follows({
      "/home/me/work/app/node_modules/cloudpin/dist/cli.js":
        "/home/me/.local/share/pnpm/store/v11/links/@/cloudpin/1.2.0/abc/node_modules/cloudpin/dist/cli.js",
    });
    expect(linux("/home/me/work/app/node_modules/cloudpin/dist/cli.js", LINUX_ENV, realpath)).toBe("npm");
  });

  it("is npm for a package whose name starts with cloudpin, in every global folder", () => {
    expect(linux("/home/me/.local/share/pnpm/global/5/.pnpm/cloudpin-dev@1.0.0/node_modules/cloudpin-dev/dist/cli.js", LINUX_ENV)).toBe("npm");
    expect(linux("/home/me/.local/share/pnpm/global/v11/abc/node_modules/cloudpin-dev/dist/cli.js", LINUX_ENV)).toBe("npm");
    expect(linux("/home/me/.volta/tools/image/packages/cloudpin-dev/lib/node_modules/cloudpin-dev/dist/cli.js", LINUX_ENV)).toBe("npm");
    expect(linux("/home/me/.config/yarn/global/node_modules/cloudpin-dev/dist/cli.js", LINUX_ENV)).toBe("npm");
    expect(linux("/home/me/.bun/install/global/node_modules/cloudpin-dev/dist/cli.js", LINUX_ENV)).toBe("npm");
  });

  it("is npm for a cloudpin nested inside another global package", () => {
    expect(linux("/home/me/.config/yarn/global/node_modules/other/node_modules/cloudpin/dist/cli.js", LINUX_ENV)).toBe("npm");
    expect(linux("/home/me/.bun/install/global/node_modules/other/node_modules/cloudpin/dist/cli.js", LINUX_ENV)).toBe("npm");
    expect(linux("/home/me/.local/share/pnpm/global/5/.pnpm/other@1.0.0/node_modules/other/node_modules/cloudpin/dist/cli.js", LINUX_ENV)).toBe("npm");
  });

  it("is npm for another tool's launcher in a package manager's bin folder", () => {
    expect(linux("/home/me/.bun/bin/cloudpin-dev", LINUX_ENV)).toBe("npm");
    expect(linux("/home/me/.volta/bin/node", LINUX_ENV, follows({ "/home/me/.volta/bin/node": "/home/me/.volta/bin/volta-shim" }))).toBe("npm");
    expect(win("C:\\Users\\me\\AppData\\Local\\pnpm\\bin\\cloudpin-nightly.cmd", WIN_PM_ENV)).toBe("npm");
    expect(win("C:\\Users\\me\\AppData\\Local\\Yarn\\bin\\node.cmd", WIN_PM_ENV)).toBe("npm");
    // A launcher one folder down is not in the bin folder.
    expect(win("C:\\Users\\me\\.bun\\bin\\x\\cloudpin.exe", WIN_PM_ENV)).toBe("npm");
  });

  it("is npm for a global under Volta's Node image (an unintercepted npm install --global)", () => {
    expect(linux("/home/me/.volta/tools/image/node/22.17.0/lib/node_modules/cloudpin/dist/cli.js", LINUX_ENV)).toBe("npm");
  });

  it("is npm for an npm global on Linux whose bin link sits where Yarn's would", () => {
    const realpath = follows({ "/usr/local/bin/cloudpin": "/usr/local/lib/node_modules/cloudpin/dist/cli.js" });
    expect(linux("/usr/local/bin/cloudpin", LINUX_ENV, realpath)).toBe("npm");
  });

  it("keeps brew and Scoop installs theirs with every package manager's variables set", () => {
    const all = { PNPM_HOME: "/home/me/.local/share/pnpm", VOLTA_HOME: "/home/me/.volta", BUN_INSTALL: "/home/me/.bun" };
    expect(mac("/opt/homebrew/Cellar/cloudpin/1.2.0/libexec/lib/node_modules/cloudpin/dist/cli.js", { ...MAC_ENV, ...all })).toBe("brew");
    expect(win("C:\\Users\\me\\scoop\\apps\\cloudpin\\current\\dist\\cli.js", { ...WIN_PM_ENV, PNPM_HOME: "C:\\Users\\me\\scoop\\persist\\pnpm" })).toBe("scoop");
  });

  it("is npm for an npm launcher in a folder that is also pnpm's home, when its link leads outside every layout", () => {
    const env = { ...LINUX_ENV, PNPM_HOME: "/home/me/.local/bin" };
    const realpath = follows({ "/home/me/.local/bin/cloudpin": "/home/me/.local/lib/node_modules/cloudpin/dist/cli.js" });
    expect(linux("/home/me/.local/bin/cloudpin", env, realpath)).toBe("npm");
    // Control: a pnpm script there (a file, not a link) is still pnpm's.
    expect(linux("/home/me/.local/bin/cloudpin", env)).toBe("pnpm");
  });

  it("is pnpm, not Scoop, for a pnpm global when pnpm's home is in Scoop's persist folder", () => {
    const env = { ...WIN_PM_ENV, PNPM_HOME: "C:\\Users\\me\\scoop\\persist\\pnpm" };
    expect(win("C:\\Users\\me\\scoop\\persist\\pnpm\\global\\v11\\abc\\node_modules\\cloudpin\\dist\\cli.js", env)).toBe("pnpm");
  });

});

describe("installMethod: pnpm", () => {
  it("is pnpm in the default global folder on each platform, pnpm 10 (global/5) and pnpm 11+ (global/v11/<id>)", () => {
    expect(linux("/home/me/.local/share/pnpm/global/5/.pnpm/cloudpin@1.2.0/node_modules/cloudpin/dist/cli.js", LINUX_ENV)).toBe("pnpm");
    expect(linux("/home/me/.local/share/pnpm/global/5/node_modules/cloudpin/dist/cli.js", LINUX_ENV)).toBe("pnpm");
    expect(linux("/home/me/.local/share/pnpm/global/v11/2f1c-19a-0/node_modules/cloudpin/dist/cli.js", LINUX_ENV)).toBe("pnpm");
    expect(mac("/Users/me/Library/pnpm/global/v11/abc/node_modules/.pnpm/cloudpin@1.2.0/node_modules/cloudpin/dist/cli.js", MAC_ENV)).toBe("pnpm");
    expect(win("C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\cloudpin@1.2.0\\node_modules\\cloudpin\\dist\\cli.js", WIN_PM_ENV)).toBe("pnpm");
    expect(win("c:\\users\\ME\\appdata\\local\\PNPM\\global\\v11\\abc\\node_modules\\cloudpin\\dist\\cli.js", WIN_PM_ENV)).toBe("pnpm");
  });

  it("honours PNPM_HOME and XDG_DATA_HOME", () => {
    const script = "/opt/pnpm-home/global/v11/abc/node_modules/cloudpin/dist/cli.js";
    expect(linux(script, LINUX_ENV)).toBe("npm");
    expect(linux(script, { ...LINUX_ENV, PNPM_HOME: "/opt/pnpm-home" })).toBe("pnpm");
    expect(linux("/data/pnpm/global/5/node_modules/cloudpin/dist/cli.js", { ...LINUX_ENV, XDG_DATA_HOME: "/data" })).toBe("pnpm");
    expect(win("D:\\pnpm\\global\\v11\\abc\\node_modules\\cloudpin\\dist\\cli.js", { ...WIN_PM_ENV, pnpm_home: "D:\\pnpm" })).toBe("pnpm");
  });

  it("honours PNPM_CONFIG_GLOBAL_DIR (or pnpm_config_global_dir), which replaces <home>/global", () => {
    const v11 = "/srv/pnpm-global/v11/abc/node_modules/cloudpin/dist/cli.js";
    const v10 = "/srv/pnpm-global/5/.pnpm/cloudpin@1.2.0/node_modules/cloudpin/dist/cli.js";
    expect(linux(v11, LINUX_ENV)).toBe("npm");
    expect(linux(v11, { ...LINUX_ENV, PNPM_CONFIG_GLOBAL_DIR: "/srv/pnpm-global" })).toBe("pnpm");
    expect(linux(v10, { ...LINUX_ENV, pnpm_config_global_dir: "/srv/pnpm-global" })).toBe("pnpm");
    expect(win("D:\\pg\\v11\\abc\\node_modules\\cloudpin\\dist\\cli.js", { ...WIN_PM_ENV, PNPM_CONFIG_GLOBAL_DIR: "D:\\pg" })).toBe("pnpm");
    // Control: the folder itself is not <home>/global, so nothing below a `global` subfolder of it counts.
    expect(linux("/srv/pnpm-global/global/v11/abc/node_modules/cloudpin/dist/cli.js", { ...LINUX_ENV, PNPM_CONFIG_GLOBAL_DIR: "/srv/pnpm-global" })).toBe("npm");
  });

  it("is pnpm through the global virtual store, where only the path as run is in the global folder (pnpm 11+)", () => {
    const script = "/home/me/.local/share/pnpm/global/v11/0d9f/node_modules/cloudpin/dist/cli.js";
    const realpath = follows({ [script]: "/home/me/.local/share/pnpm/store/v11/links/@/cloudpin/1.2.0/abc/node_modules/cloudpin/dist/cli.js" });
    expect(linux(script, LINUX_ENV, realpath)).toBe("pnpm");
  });

  it("is pnpm for its launchers: in PNPM_HOME (pnpm 10) and PNPM_HOME/bin (pnpm 11+), scripts or links", () => {
    for (const shim of ["cloudpin", "cloudpin.cmd", "cloudpin.CMD", "cloudpin.ps1"]) {
      expect(win(`C:\\Users\\me\\AppData\\Local\\pnpm\\${shim}`, WIN_PM_ENV), shim).toBe("pnpm");
      expect(win(`C:\\Users\\me\\AppData\\Local\\pnpm\\bin\\${shim}`, WIN_PM_ENV), shim).toBe("pnpm");
    }
    expect(linux("/home/me/.local/share/pnpm/cloudpin", LINUX_ENV)).toBe("pnpm");
    expect(linux("/home/me/.local/share/pnpm/bin/cloudpin", LINUX_ENV)).toBe("pnpm");
    // preferSymlinkedExecutables: a link into the global virtual store.
    const realpath = follows({ "/Users/me/Library/pnpm/bin/cloudpin": "/Users/me/Library/pnpm/store/v11/links/@/cloudpin/1.2.0/abc/node_modules/cloudpin/dist/cli.js" });
    expect(mac("/Users/me/Library/pnpm/bin/cloudpin", MAC_ENV, realpath)).toBe("pnpm");
  });
});

describe("installMethod: Volta", () => {
  it("is volta in the package image on each platform, and honours VOLTA_HOME", () => {
    expect(linux("/home/me/.volta/tools/image/packages/cloudpin/lib/node_modules/cloudpin/dist/cli.js", LINUX_ENV)).toBe("volta");
    expect(mac("/Users/me/.volta/tools/image/packages/cloudpin/lib/node_modules/cloudpin/dist/cli.js", MAC_ENV)).toBe("volta");
    expect(win("C:\\Users\\me\\AppData\\Local\\Volta\\tools\\image\\packages\\cloudpin\\node_modules\\cloudpin\\dist\\cli.js", WIN_PM_ENV)).toBe("volta");
    const custom = "/opt/volta/tools/image/packages/cloudpin/lib/node_modules/cloudpin/dist/cli.js";
    expect(linux(custom, LINUX_ENV)).toBe("npm");
    expect(linux(custom, { ...LINUX_ENV, VOLTA_HOME: "/opt/volta" })).toBe("volta");
  });

  it("is volta for its shims: links to volta-shim on macOS and Linux, .cmd and bash scripts on Windows", () => {
    const realpath = follows({ "/home/me/.volta/bin/cloudpin": "/home/me/.volta/bin/volta-shim" });
    expect(linux("/home/me/.volta/bin/cloudpin", LINUX_ENV, realpath)).toBe("volta");
    expect(win("C:\\Users\\me\\AppData\\Local\\Volta\\bin\\cloudpin.cmd", WIN_PM_ENV)).toBe("volta");
    expect(win("C:\\Users\\me\\AppData\\Local\\Volta\\bin\\cloudpin", WIN_PM_ENV)).toBe("volta");
    // A Volta installed elsewhere (a package manager's volta) links to its own volta-shim, wherever that is.
    const elsewhere = follows({ "/home/me/.volta/bin/cloudpin": "/home/linuxbrew/.linuxbrew/Cellar/volta/2.0.2/bin/volta-shim" });
    expect(linux("/home/me/.volta/bin/cloudpin", LINUX_ENV, elsewhere)).toBe("volta");
    // Control: a link in Volta's bin folder to something that is not Volta's shim is not Volta's.
    const other = follows({ "/home/me/.volta/bin/cloudpin": "/home/me/.local/lib/node_modules/cloudpin/dist/cli.js" });
    expect(linux("/home/me/.volta/bin/cloudpin", LINUX_ENV, other)).toBe("npm");
  });
});

describe("installMethod: Yarn classic", () => {
  it("is yarn in the default global folder on each platform, and honours XDG_DATA_HOME off Windows", () => {
    expect(linux("/home/me/.config/yarn/global/node_modules/cloudpin/dist/cli.js", LINUX_ENV)).toBe("yarn");
    expect(mac("/Users/me/.config/yarn/global/node_modules/cloudpin/dist/cli.js", MAC_ENV)).toBe("yarn");
    expect(linux("/data/yarn/global/node_modules/cloudpin/dist/cli.js", { ...LINUX_ENV, XDG_DATA_HOME: "/data" })).toBe("yarn");
    expect(win("C:\\Users\\me\\AppData\\Local\\Yarn\\Data\\global\\node_modules\\cloudpin\\dist\\cli.js", WIN_PM_ENV)).toBe("yarn");
    // Without LOCALAPPDATA, Yarn on Windows falls back to ~/.config/yarn.
    expect(win("C:\\Users\\me\\.config\\yarn\\global\\node_modules\\cloudpin\\dist\\cli.js", WIN_ENV)).toBe("yarn");
  });

  it("is yarn for its launchers: links followed on macOS and Linux, .cmd shims on Windows", () => {
    const realpath = follows({ "/usr/local/bin/cloudpin": "/home/me/.config/yarn/global/node_modules/cloudpin/dist/cli.js" });
    expect(linux("/usr/local/bin/cloudpin", LINUX_ENV, realpath)).toBe("yarn");
    expect(win("C:\\Users\\me\\AppData\\Local\\Yarn\\bin\\cloudpin.cmd", WIN_PM_ENV)).toBe("yarn");
    expect(win("C:\\Users\\me\\AppData\\Local\\Yarn\\bin\\cloudpin", WIN_PM_ENV)).toBe("yarn");
    expect(win("C:\\Users\\me\\.yarn\\bin\\cloudpin.cmd", WIN_ENV)).toBe("yarn");
  });
});

describe("installMethod: Bun", () => {
  it("is bun in the default global folder on each platform", () => {
    expect(linux("/home/me/.bun/install/global/node_modules/cloudpin/dist/cli.js", LINUX_ENV)).toBe("bun");
    expect(mac("/Users/me/.bun/install/global/node_modules/cloudpin/dist/cli.js", MAC_ENV)).toBe("bun");
    expect(win("C:\\Users\\me\\.bun\\install\\global\\node_modules\\cloudpin\\dist\\cli.js", WIN_PM_ENV)).toBe("bun");
  });

  it("honours BUN_INSTALL_GLOBAL_DIR, BUN_INSTALL and XDG_CACHE_HOME", () => {
    expect(linux("/g/node_modules/cloudpin/dist/cli.js", LINUX_ENV)).toBe("npm");
    expect(linux("/g/node_modules/cloudpin/dist/cli.js", { ...LINUX_ENV, BUN_INSTALL_GLOBAL_DIR: "/g" })).toBe("bun");
    expect(linux("/opt/bun/install/global/node_modules/cloudpin/dist/cli.js", { ...LINUX_ENV, BUN_INSTALL: "/opt/bun" })).toBe("bun");
    expect(linux("/cache/.bun/install/global/node_modules/cloudpin/dist/cli.js", { ...LINUX_ENV, XDG_CACHE_HOME: "/cache" })).toBe("bun");
    expect(win("D:\\bun\\install\\global\\node_modules\\cloudpin\\dist\\cli.js", { ...WIN_PM_ENV, BUN_INSTALL: "D:\\bun" })).toBe("bun");
  });

  it("is bun for its launchers: links on macOS and Linux, an exe plus .bunx on Windows; honours BUN_INSTALL_BIN", () => {
    const realpath = follows({ "/home/me/.bun/bin/cloudpin": "/home/me/.bun/install/global/node_modules/cloudpin/dist/cli.js" });
    expect(linux("/home/me/.bun/bin/cloudpin", LINUX_ENV, realpath)).toBe("bun");
    expect(win("C:\\Users\\me\\.bun\\bin\\cloudpin.exe", WIN_PM_ENV)).toBe("bun");
    expect(win("C:\\Users\\me\\.bun\\bin\\cloudpin.bunx", WIN_PM_ENV)).toBe("bun");
    expect(win("D:\\tools\\cloudpin.exe", WIN_PM_ENV)).toBe("npm");
    expect(win("D:\\tools\\cloudpin.exe", { ...WIN_PM_ENV, BUN_INSTALL_BIN: "D:\\tools" })).toBe("bun");
  });
});

describe("installMethod: fallbacks", () => {
  it("uses the unresolved path when realpath fails", () => {
    expect(mac("/opt/homebrew/Cellar/cloudpin/1.2.0/libexec/lib/node_modules/cloudpin/dist/cli.js", {}, fails)).toBe("brew");
    expect(win("C:\\Users\\me\\scoop\\apps\\cloudpin\\current\\dist\\cli.js", WIN_ENV, fails)).toBe("scoop");
    expect(mac("/usr/local/lib/node_modules/cloudpin/dist/cli.js", {}, fails)).toBe("npm");
  });

  it("lets the real path decide when the path as run and the real path match different installs", () => {
    const script = "/home/me/.local/share/pnpm/global/5/node_modules/cloudpin/dist/cli.js";
    const keg = "/home/linuxbrew/.linuxbrew/Cellar/cloudpin/1.2.0/libexec/lib/node_modules/cloudpin/dist/cli.js";
    expect(linux(script, LINUX_ENV)).toBe("pnpm");
    expect(linux(keg, LINUX_ENV)).toBe("brew");
    expect(linux(script, LINUX_ENV, follows({ [script]: keg }))).toBe("brew");
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
    // README's install lines; Volta has none there, `volta install` is its documented install and upgrade.
    ["pnpm", "pnpm add --global cloudpin", "pnpm add --global cloudpin"],
    ["volta", "volta install cloudpin", "volta install cloudpin"],
    ["yarn", "yarn global add cloudpin", "yarn global add cloudpin"],
    ["bun", "bun add --global cloudpin@latest", "bun add --global cloudpin@latest"],
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
    expect(pathFix("pnpm")).toMatch(/^pnpm add --global cloudpin, .*pnpm bin --global.* on PATH; pnpm setup adds it$/);
    expect(pathFix("volta")).toMatch(/^volta install cloudpin, .*VOLTA_HOME.* on PATH; volta setup adds it$/);
    expect(pathFix("yarn")).toMatch(/^yarn global add cloudpin, .*yarn global bin.* on PATH$/);
    expect(pathFix("bun")).toMatch(/^bun add --global cloudpin@latest, .*bun pm bin --global.* on PATH$/);
  });

  it("never sends a package-manager install to npm", () => {
    for (const method of ["pnpm", "volta", "yarn", "bun"] as const) {
      for (const text of [upgradeCommand(method), reinstallCommand(method), pathFix(method)]) expect(text, method).not.toMatch(/\bnpm\b/);
    }
  });
});
