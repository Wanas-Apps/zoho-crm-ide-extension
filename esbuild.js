/*
 * esbuild bundler for the extension. Bundles src/extension.ts and the reused
 * Zoho CRM core service modules (imported from the `@wanasapps/zcrm-core` package)
 * into a single self-contained dist/extension.js, keeping `vscode` external.
 *
 *   node esbuild.js                build once (dev, sourcemaps)
 *   node esbuild.js --production   minified production build
 *   node esbuild.js --watch        rebuild on change
 *   node esbuild.js --metafile     write dist/metafile.json + bundle-gate report
 */
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const wantMeta = process.argv.includes('--metafile') || production;

const OUTFILE = path.join(__dirname, 'dist', 'extension.js');
const STDIO_OUTFILE = path.join(__dirname, 'dist', 'mcp-stdio.js');

// Heavy CLI-only deps that must NOT leak into the extension bundle (the C5
// bundle-gate). If any appear in the metafile inputs the import bridge is not
// viable and the core split (M6) must precede the feature milestones.
const HEAVY = ['express', 'inquirer', 'commander', 'archiver', 'dotenv', 'chalk', 'ora', 'nodemon'];

const COMMON = {
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
    metafile: true
};

async function main() {
    // 1) The extension (vscode external). 2) The standalone stdio MCP server
    //    (a plain Node binary launched by external agents — no vscode at all).
    const ctx = await esbuild.context({
        ...COMMON,
        entryPoints: [path.join(__dirname, 'src', 'extension.ts')],
        outfile: OUTFILE,
        external: ['vscode']
    });
    const stdioCtx = await esbuild.context({
        ...COMMON,
        entryPoints: [path.join(__dirname, 'src', 'zoho', 'mcp', 'mcpStdio.ts')],
        outfile: STDIO_OUTFILE
    });

    if (watch) {
        await ctx.watch();
        await stdioCtx.watch();
        console.log('[esbuild] watching…');
        return;
    }

    const result = await ctx.rebuild();
    const stdioResult = await stdioCtx.rebuild();
    await ctx.dispose();
    await stdioCtx.dispose();

    if (wantMeta && result.metafile) {
        fs.writeFileSync(path.join(__dirname, 'dist', 'metafile.json'), JSON.stringify(result.metafile));
        reportBundleGate(result.metafile, 'extension.js', OUTFILE);
    }
    if (wantMeta && stdioResult.metafile) {
        reportBundleGate(stdioResult.metafile, 'mcp-stdio.js', STDIO_OUTFILE);
    }
}

function reportBundleGate(metafile, label = 'extension.js', outfile = OUTFILE) {
    const inputs = Object.keys(metafile.inputs);
    const norm = inputs.map((i) => i.replace(/\\/g, '/'));
    const leaked = HEAVY.filter((h) => norm.some((i) => i.includes(`node_modules/${h}/`)));
    const size = fs.existsSync(outfile) ? fs.statSync(outfile).size : 0;

    console.log(`\n──────────── Bundle gate (C5) — ${label} ────────────`);
    console.log(`bundled inputs : ${inputs.length}`);
    console.log(`dist size      : ${(size / 1024).toFixed(1)} KB`);
    if (leaked.length) {
        console.log(`HEAVY DEP LEAK : ${leaked.join(', ')}  ⛔  bridge NOT viable as-is`);
        process.exitCode = 2;
    } else {
        console.log(`heavy-dep leak : none ✅  (no ${HEAVY.join('/')})`);
    }
    console.log('──────────────────────────────────────────\n');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
