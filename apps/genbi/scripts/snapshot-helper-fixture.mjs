/** Executed in the fresh installed package's process with checkout access blocked. */
export async function installedSnapshotHelperFixture(installedRoot, configuredPython) {
  const fs = await import("node:fs/promises"); const sync = await import("node:fs"); const path = await import("node:path"); const os = await import("node:os"); const url = await import("node:url");
  if (!configuredPython || !path.isAbsolute(configuredPython)) throw new Error("Snapshot acceptance requires an explicitly configured Python interpreter");
  const { DockerSnapshotDriver, SNAPSHOT_HELPER_PATH, snapshotHash } = await import(url.pathToFileURL(path.join(installedRoot, "dist-server/server/runtime-host/openshell-snapshot-driver.js")).href);
  const { snapshotSourceAuthority } = await import(url.pathToFileURL(path.join(installedRoot, "dist-server/server/runtime-host/openshell-project-snapshots.js")).href);
  const { resolveEnrichmentBinding } = await import(url.pathToFileURL(path.join(installedRoot, "dist-server/server/enrichment.js")).href);
  const { Store } = await import(url.pathToFileURL(path.join(installedRoot, "dist-server/server/db.js")).href);
  if (!SNAPSHOT_HELPER_PATH.startsWith(installedRoot + path.sep)) throw new Error("Snapshot helper escaped the installed package");
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "genbi-installed-snapshot-")));
  const store = new Store(":memory:"); const helper = await fs.readFile(SNAPSHOT_HELPER_PATH);
  try {
    const project = path.join(root, "project"); await fs.mkdir(path.join(project, "target"), { recursive: true }); await fs.mkdir(path.join(project, "data"));
    await fs.writeFile(path.join(project, "wren_project.yml"), "version: 1\ndata_source: duckdb\nprofile: snapshot\n"); await fs.writeFile(path.join(project, "target/mdl.json"), '{"models":[]}'); await fs.writeFile(path.join(project, "data/input.txt"), "installed synthetic data");
    store.activateEnrichmentBinding(resolveEnrichmentBinding(project));
    const digest = `sha256:${"a".repeat(64)}`, executable = await fs.realpath(configuredPython), docker = await fs.realpath("/bin/echo");
    const paths = ["wren_project.yml", "target/mdl.json", "data/input.txt"];
    const request = snapshotSourceAuthority({ store, currentProject: () => project, approvedFiles: paths, currentContext: () => digest })();
    const configuration = { executable: docker, executableDigest: snapshotHash(await fs.readFile(docker)), version: "0.0.1", gateway: "fixture", workspace: "default", image: digest, supervisorImage: digest,
      policy: SNAPSHOT_HELPER_PATH, policyDigest: snapshotHash(helper), home: root, configHome: root, stateHome: root, dockerExecutable: docker, dockerRealpath: docker, dockerDigest: snapshotHash(await fs.readFile(docker)), dockerSocket: path.join(root, "unused.sock"), dockerNamespace: "fixture", exclusive: true,
      snapshotCapture: { executable, realpath: executable, digest: snapshotHash(await fs.readFile(executable)), helperDigest: snapshotHash(helper), approvedFiles: paths } };
    const driver = new DockerSnapshotDriver(configuration);
    const manifest = await driver.capture(request, path.join(root, "archive.tar"), new AbortController().signal);
    if (!manifest.files.some((entry) => entry.path === "project/data/input.txt") || !sync.existsSync(path.join(root, "archive.tar"))) throw new Error("Installed capture did not produce complete evidence");
    const strictConfig = '{"strict_mode":true}\n';
    const governedRequest = { ...request, projection: { "wren-home/profiles.yml": request.projection["wren-home/profiles.yml"], "wren-home/config.json": strictConfig } };
    const governed = await driver.capture(governedRequest, path.join(root, "governed.tar"), new AbortController().signal);
    if (governed.files.find(entry => entry.path === "project/wren_project.yml")?.sha256 !== snapshotHash(await fs.readFile(path.join(project, "wren_project.yml"))).slice(7)
      || governed.files.find(entry => entry.path === "wren-home/config.json")?.sha256 !== snapshotHash(strictConfig).slice(7)) throw new Error("Installed governed capture changed approved metadata or strict config");
    await fs.appendFile(SNAPSHOT_HELPER_PATH, "\n# modified fixture\n");
    let denied = false;
    try { await driver.capture(request, path.join(root, "forbidden.tar"), new AbortController().signal); } catch { denied = true; }
    if (!denied || sync.existsSync(path.join(root, "forbidden.tar"))) throw new Error("Installed helper tamper did not fail before effects");
    process.stdout.write(JSON.stringify({ installedSnapshotHelper: true, protocol: "genbi-snapshot/1", digest: manifest.digest, tamperDenied: true, governedProjection: true }) + "\n");
  } finally { await fs.writeFile(SNAPSHOT_HELPER_PATH, helper); store.close(); await fs.rm(root, { recursive: true, force: true }); }
}
