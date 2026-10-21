# Application releases

The application badge and public `version.json` use `scripts/pfx-release.mjs`. The application release is independent of package and engine versions.

`release.config.json` records the existing release and its Git baseline. Each first-parent commit touching `sourcePaths` advances the patch (or numeric prerelease) once. Rebuilding a commit keeps its version. Documentation-only and generated-runtime preservation commits do not advance it. Full Git history is required; shallow builds fail rather than invent a number.

Do not edit the badge number or bump a version for each deployment. Run `node scripts/pfx-release.mjs` to inspect the release. Vite builds emit metadata automatically; static build assembly calls the same script with its output directory. Existing deployment workflows supply full history.

Change the base version/channel only for a deliberate minor, major or lifecycle transition, setting the baseline to the preceding main commit. Keep the new base ahead of published releases. The next relevant commit advances from that base.
