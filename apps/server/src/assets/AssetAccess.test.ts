import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import {
  ASSET_ROUTE_PREFIX,
  PI_EXPORT_ARTIFACT_LIMIT,
  issueAssetUrl,
  issuePiExportAssetUrl,
  resolveAsset,
} from "./AssetAccess.ts";

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-asset-access-test-",
});
const testLayer = Layer.mergeAll(
  configLayer,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  ServerSecretStore.layer.pipe(Layer.provide(configLayer)),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("AssetAccess", () => {
  it.effect("issues workspace URLs that resolve the entry file and sibling assets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-workspace-",
      });
      const htmlPath = path.join(root, "report.html");
      const cssPath = path.join(root, "report.css");
      yield* fileSystem.writeFileString(htmlPath, '<link rel="stylesheet" href="report.css">');
      yield* fileSystem.writeFileString(cssPath, "body { color: red; }");
      yield* fileSystem.writeFileString(path.join(root, ".env"), "SECRET=value");
      const canonicalHtmlPath = yield* fileSystem.realPath(htmlPath);
      const canonicalCssPath = yield* fileSystem.realPath(cssPath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "report.html")).toEqual({
        kind: "file",
        path: canonicalHtmlPath,
      });
      expect(yield* resolveAsset(token, "report.css")).toEqual({
        kind: "file",
        path: canonicalCssPath,
      });
      expect(yield* resolveAsset(token, "../secret.txt")).toBeNull();
      expect(yield* resolveAsset(token, ".env")).toBeNull();
      expect(yield* resolveAsset(`${token}tampered`, "report.html")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects workspace files outside the authorized root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-root-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-outside-",
      });
      const htmlPath = path.join(outside, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>outside</p>");

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error.message).toBe("Workspace file path must be relative to the project root.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspacePathValidationError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves non-missing canonical path failures when issuing asset URLs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-permission-root-",
      });
      const htmlPath = path.join(root, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>report</p>");
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "realPath",
        pathOrDescriptor: htmlPath,
      });
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        realPath: () => Effect.fail(cause),
      });

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem), Effect.flip);

      expect(error.message).toBe("Failed to inspect the workspace asset.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspaceAssetInspectionError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBe(cause);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues exact workspace URLs for image previews", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-image-workspace-",
      });
      const assetsDirectory = path.join(root, "assets");
      const imagePath = path.join(assetsDirectory, "icon.png");
      const siblingPath = path.join(assetsDirectory, "other.png");
      yield* fileSystem.makeDirectory(assetsDirectory, { recursive: true });
      yield* fileSystem.writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));
      yield* fileSystem.writeFile(siblingPath, new Uint8Array([137, 80, 78, 71]));
      const canonicalImagePath = yield* fileSystem.realPath(imagePath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: imagePath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "icon.png")).toEqual({
        kind: "file",
        path: canonicalImagePath,
      });
      expect(yield* resolveAsset(token, "other.png")).toBeNull();
      expect(yield* resolveAsset(token, "../icon.png")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues exact attachment capabilities by attachment id", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.png`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

      const result = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "ignored.png")).toEqual({
        kind: "file",
        path: attachmentPath,
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues opaque exact capabilities for Pi HTML exports", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "d4-export-test-" });
      const exportPath = path.join(directory, "session.html");
      yield* fileSystem.writeFileString(exportPath, "<html>export</html>");
      const canonicalPath = yield* fileSystem.realPath(exportPath);

      const result = yield* issuePiExportAssetUrl({ canonicalPath, fileName: "session.html" });
      expect(result.handle).not.toContain(canonicalPath);
      expect(result.relativeUrl).not.toContain(canonicalPath);
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);
      expect(yield* resolveAsset(token, "session.html")).toEqual({
        kind: "file",
        path: canonicalPath,
        downloadName: "session.html",
      });
      expect(yield* resolveAsset(token, "../session.html")).toBeNull();
      expect(yield* resolveAsset(token, "other.html")).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("removes an unregistered Pi HTML export when signing fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectory({ prefix: "d4-export-failure-test-" });
      const exportPath = path.join(directory, "session.html");
      yield* fileSystem.writeFileString(exportPath, "<html>export</html>");
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const failingSecretStore = {
        ...secretStore,
        getOrCreateRandom: () =>
          Effect.fail(
            new ServerSecretStore.SecretStoreRandomGenerationError({
              resource: "test signing key",
              cause: new Error("unavailable"),
            }),
          ),
      };

      const exit = yield* Effect.exit(
        issuePiExportAssetUrl({
          canonicalPath: yield* fileSystem.realPath(exportPath),
          fileName: "session.html",
        }).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, failingSecretStore)),
      );
      expect(exit._tag).toBe("Failure");
      expect(yield* fileSystem.exists(directory)).toBe(false);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("retains the oldest export when capacity eviction fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directories: string[] = [];
      let oldestToken = "";
      for (let index = 0; index < PI_EXPORT_ARTIFACT_LIMIT; index += 1) {
        const directory = yield* fileSystem.makeTempDirectory({ prefix: "d4-export-fill-test-" });
        directories.push(directory);
        const fileName = `fill-${index}.html`;
        const exportPath = path.join(directory, fileName);
        yield* fileSystem.writeFileString(exportPath, "<html>export</html>");
        const result = yield* issuePiExportAssetUrl({
          canonicalPath: yield* fileSystem.realPath(exportPath),
          fileName,
        });
        if (index === 0) {
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          oldestToken = suffix.slice(0, suffix.indexOf("/"));
        }
      }
      const rejectedDirectory = yield* fileSystem.makeTempDirectory({
        prefix: "d4-export-rejected-test-",
      });
      directories.push(rejectedDirectory);
      const rejectedPath = path.join(rejectedDirectory, "rejected.html");
      yield* fileSystem.writeFileString(rejectedPath, "<html>export</html>");
      const failingFileSystem = {
        ...fileSystem,
        remove: (pathOrDescriptor: string | number) =>
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: "remove",
              pathOrDescriptor,
              description: "Test PermissionDenied remove failure.",
            }),
          ),
      };

      const exit = yield* Effect.exit(
        issuePiExportAssetUrl({
          canonicalPath: yield* fileSystem.realPath(rejectedPath),
          fileName: "rejected.html",
        }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem)),
      );
      expect(exit._tag).toBe("Failure");
      expect(yield* resolveAsset(oldestToken, "fill-0.html")).not.toBeNull();
      yield* Effect.forEach(
        directories,
        (directory) => fileSystem.remove(directory, { recursive: true, force: true }),
        { discard: true },
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("retains registry ownership when capacity eviction is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directories: string[] = [];
        let oldestToken = "";
        for (let index = 0; index < PI_EXPORT_ARTIFACT_LIMIT; index += 1) {
          const directory = yield* fileSystem.makeTempDirectory({
            prefix: "d4-export-interrupt-fill-test-",
          });
          directories.push(directory);
          const fileName = `interrupt-fill-${index}.html`;
          const exportPath = path.join(directory, fileName);
          yield* fileSystem.writeFileString(exportPath, "<html>export</html>");
          const result = yield* issuePiExportAssetUrl({
            canonicalPath: yield* fileSystem.realPath(exportPath),
            fileName,
          });
          if (index === 0) {
            const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
            oldestToken = suffix.slice(0, suffix.indexOf("/"));
          }
        }
        const rejectedDirectory = yield* fileSystem.makeTempDirectory({
          prefix: "d4-export-interrupted-test-",
        });
        directories.push(rejectedDirectory);
        const rejectedPath = path.join(rejectedDirectory, "interrupted.html");
        yield* fileSystem.writeFileString(rejectedPath, "<html>export</html>");
        const evictionStarted = yield* Deferred.make<void>();
        const releaseEviction = yield* Deferred.make<void>();
        let removeCalls = 0;
        const blockingFileSystem = {
          ...fileSystem,
          remove: (pathOrDescriptor: string | number) => {
            removeCalls += 1;
            if (removeCalls === 1) {
              return Deferred.succeed(evictionStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseEviction)),
              );
            }
            return fileSystem.remove(String(pathOrDescriptor), { recursive: true, force: true });
          },
        };
        const registration = yield* issuePiExportAssetUrl({
          canonicalPath: yield* fileSystem.realPath(rejectedPath),
          fileName: "interrupted.html",
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, blockingFileSystem),
          Effect.forkScoped,
        );
        yield* Deferred.await(evictionStarted);
        expect(yield* resolveAsset(oldestToken, "interrupt-fill-0.html")).not.toBeNull();

        yield* Fiber.interrupt(registration);
        expect(yield* resolveAsset(oldestToken, "interrupt-fill-0.html")).not.toBeNull();
        expect(yield* fileSystem.exists(rejectedDirectory)).toBe(false);
        yield* Deferred.succeed(releaseEviction, undefined);
        yield* Effect.forEach(
          directories,
          (directory) => fileSystem.remove(directory, { recursive: true, force: true }),
          { discard: true },
        );
      }),
    ).pipe(Effect.provide(testLayer)),
  );

  it.effect("evicts the oldest Pi HTML export at the artifact limit", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      let firstToken = "";
      const directories: string[] = [];

      for (let index = 0; index <= PI_EXPORT_ARTIFACT_LIMIT; index += 1) {
        const directory = yield* fileSystem.makeTempDirectory({ prefix: "d4-export-limit-test-" });
        directories.push(directory);
        const fileName = `session-${index}.html`;
        const exportPath = path.join(directory, fileName);
        yield* fileSystem.writeFileString(exportPath, "<html>export</html>");
        const result = yield* issuePiExportAssetUrl({
          canonicalPath: yield* fileSystem.realPath(exportPath),
          fileName,
        });
        if (index === 0) {
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          firstToken = suffix.slice(0, suffix.indexOf("/"));
        }
      }

      expect(yield* resolveAsset(firstToken, "session-0.html")).toBeNull();
      yield* Effect.forEach(
        directories,
        (directory) => fileSystem.remove(directory, { recursive: true, force: true }),
        { discard: true },
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps parallel Pi HTML export registration within the artifact limit", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directories = yield* Effect.forEach(
        Array.from({ length: PI_EXPORT_ARTIFACT_LIMIT + 8 }),
        (_, index) =>
          Effect.gen(function* () {
            const directory = yield* fileSystem.makeTempDirectory({
              prefix: "d4-export-parallel-test-",
            });
            const fileName = `parallel-${index}.html`;
            const exportPath = path.join(directory, fileName);
            yield* fileSystem.writeFileString(exportPath, "<html>export</html>");
            return { directory, fileName, exportPath: yield* fileSystem.realPath(exportPath) };
          }),
        { concurrency: "unbounded" },
      );
      const results = yield* Effect.forEach(
        directories,
        ({ exportPath, fileName }) =>
          issuePiExportAssetUrl({ canonicalPath: exportPath, fileName }),
        { concurrency: "unbounded" },
      );
      const resolved = yield* Effect.forEach(results, (result, index) => {
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const token = suffix.slice(0, suffix.indexOf("/"));
        return resolveAsset(token, `parallel-${index}.html`);
      });
      expect(resolved.filter((asset) => asset !== null)).toHaveLength(PI_EXPORT_ARTIFACT_LIMIT);
      yield* Effect.forEach(
        directories,
        ({ directory }) => fileSystem.remove(directory, { recursive: true, force: true }),
        { discard: true },
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("issues project favicon capabilities with a signed fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-",
      });
      const faviconPath = path.join(root, "favicon.svg");
      yield* fileSystem.writeFileString(faviconPath, "<svg />");
      const canonicalFaviconPath = yield* fileSystem.realPath(faviconPath);

      const faviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      const faviconSuffix = faviconResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const faviconSeparatorIndex = faviconSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          faviconSuffix.slice(0, faviconSeparatorIndex),
          faviconSuffix.slice(faviconSeparatorIndex + 1),
        ),
      ).toEqual({ kind: "file", path: canonicalFaviconPath });

      yield* fileSystem.remove(faviconPath);
      const fallbackResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(fallbackResult.relativeUrl.endsWith(`/${PROJECT_FAVICON_FALLBACK_MARKER}`)).toBe(true);
      const fallbackSuffix = fallbackResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const fallbackSeparatorIndex = fallbackSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          fallbackSuffix.slice(0, fallbackSeparatorIndex),
          fallbackSuffix.slice(fallbackSeparatorIndex + 1),
        ),
      ).toBeNull();
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves structured project favicon resolution causes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-error-",
      });
      const platformCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "stat",
      });
      const resolutionCause = new ProjectFaviconResolver.ProjectFaviconResolutionError({
        operation: "stat-candidate",
        workspaceRoot: root,
        relativePath: "favicon.svg",
        cause: platformCause,
      });
      const resolver = ProjectFaviconResolver.ProjectFaviconResolver.of({
        resolvePath: () => Effect.fail(resolutionCause),
      });

      const error = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      }).pipe(
        Effect.provideService(ProjectFaviconResolver.ProjectFaviconResolver, resolver),
        Effect.flip,
      );

      expect(error.message).toBe("Failed to resolve project favicon.");
      expect(error._tag).toBe("AssetProjectFaviconResolutionError");
      expect(error.cause).toBe(resolutionCause);
    }).pipe(Effect.provide(testLayer)),
  );
});
