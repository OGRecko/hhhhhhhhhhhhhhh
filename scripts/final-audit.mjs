import fs from "node:fs";
import path from "node:path";
import { auditNullableFlags, auditResponsePoints, checkResponseModelSource, countGenericReference, parseKnownCurves } from "./lib/speakerAuditCore.mjs";
const root=process.cwd(), files=[];
function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(["node_modules","dist",".git"].includes(e.name))continue;const p=path.join(d,e.name);e.isDirectory()?walk(p):files.push(p)}}
walk(root); const problems=[];
// Guard production code against silent numeric substitutions. `0` is a valid numeric value in
// several DSP/geometry paths, so truthiness-based defaults are not acceptable. Tests are excluded
// because regression fixtures intentionally contain the old patterns as strings.
const productionRoots=['src','server'];
const productionFiles=[];
function walkProduction(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){if(['node_modules','dist','.git'].includes(e.name))continue;const p=path.join(d,e.name);if(e.isDirectory())walkProduction(p);else if(/\.(ts|tsx|js|mjs|cjs)$/.test(e.name)&&!/\.test\./.test(e.name)&&!/\.spec\./.test(e.name))productionFiles.push(p)}}
for(const d of productionRoots) walkProduction(path.join(root,d));
for(const f of productionFiles){const s=fs.readFileSync(f,'utf8'); if(/\|\|\s*[0-9]+(?:\.[0-9]+)?/.test(s)) problems.push(`${path.relative(root,f)}: truthy numeric fallback (use explicit validation or ?? where zero is valid)`); if(/\?\?\s*0\.5\b/.test(s)) problems.push(`${path.relative(root,f)}: suspicious ?? 0.5 fallback`); if(/dtEstimate\s*\|\|\s*0\.0001|RT60[^;\n]*0\.0001|sensitivity[^;\n]*\|\|\s*89/.test(s)) problems.push(`${path.relative(root,f)}: fabricated/default acoustic metric fallback`);}

for(const f of files.filter(f=>/\.(ts|tsx|js|mjs|md|json|css)$/.test(f))){const s=fs.readFileSync(f,"utf8"); if(!/FINAL_FIX_REPORT\.md$|FINAL_VERIFICATION\.md$|final-audit\.mjs$/.test(f) && /1M CELLS MAX|1,000,000.*cell|MAX_GRID_CELLS\s*:\s*1_000_000|49,152,000/.test(s)) problems.push(`${path.relative(root,f)}: stale 1M grid reference`);}
// The release deliverable is the Windows EXE. No file may reference the retired ZIP package or its script.
const retired=[['cavity-v3.1.0','release.zip'].join('-'),['package','release.mjs'].join('-')];
for(const f of files.filter(f=>/\.(ts|tsx|js|mjs|cjs|md|json|ya?ml|html)$/.test(f)&&!/package-lock\.json$/.test(f))){const s=fs.readFileSync(f,"utf8");for(const r of retired) if(s.includes(r)) problems.push(`${path.relative(root,f)}: references retired ${r}`);}
// Source-inspection guard (NOT a runtime test): the production/desktop CSP is script-src 'self', so an inline <script> in
// index.html is silently blocked. Scripts must be external files.
{const html=fs.readFileSync(path.join(root,"index.html"),"utf8"); if(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) problems.push("index.html: inline <script> is blocked by the CSP (script-src 'self'); move it to an external file");}
const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
for(const [name,cmd] of Object.entries(pkg.scripts)){for(const m of String(cmd).matchAll(/node\s+(scripts\/[\w./-]+\.mjs)/g)) if(!fs.existsSync(path.join(root,m[1]))) problems.push(`package.json script "${name}" runs missing file ${m[1]}`);}
const lim=fs.readFileSync(path.join(root,"src/lib/publicLimits.ts"),"utf8"); if(!/MAX_GRID_CELLS:\s*50_000_000/.test(lim)) problems.push("MAX_GRID_CELLS is not 50M");
const solver=fs.readFileSync(path.join(root,"server/solverWorker.ts"),"utf8"); if(!/frequency-dependent directivity/i.test(solver)) problems.push("directivity disclosure missing"); if(/getInterpolatedMagnitude\(source\.directivityData, 1000/.test(solver)) problems.push("hard-coded 1k directivity remains");
// Speaker data: null states, generic-reference accounting, and proof the removed category synthesis stays removed.
const speakerData=JSON.parse(fs.readFileSync(path.join(root,"src/data/speakers.json"),"utf8"));
const responseSrc=fs.readFileSync(path.join(root,"src/lib/speakerResponse.ts"),"utf8");
const nullFlags=auditNullableFlags(speakerData); problems.push(...nullFlags.problems);
const pointAudit=auditResponsePoints(speakerData); problems.push(...pointAudit.problems);
const modelCheck=checkResponseModelSource(responseSrc); problems.push(...modelCheck.problems);
const genericReference=countGenericReference(speakerData,parseKnownCurves(responseSrc).ids);
const speakerWarnings=nullFlags.warnings;
console.log(JSON.stringify({ok:!problems.length,filesScanned:files.length,speakers:{genericReference,responsePoints:pointAudit.counts,nullableFlags:nullFlags.counts,categoryBasedSynthesisAbsent:modelCheck.ok},speakerWarnings,problems},null,2)); process.exitCode=problems.length?1:0;
