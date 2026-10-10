import fs from 'node:fs';
import path from 'node:path';
const root=process.cwd();
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
const notice=fs.readFileSync(path.join(root,'THIRD-PARTY-NOTICES.md'),'utf8');
const packages=new Map();
for(const [k,v] of Object.entries(lock.packages||{})){
  if(!k || !v || !v.version) continue;
  let name=v.name || null;
  if (!name && k.includes('node_modules/')) name=k.split('node_modules/').pop();
  if (name && name.includes('node_modules/')) name=name.split('node_modules/').pop();
  if(name) packages.set(`${name}@${v.version}`, {name, version:v.version});
}
const missing=[];
const problems=[];
for(const {name,version} of packages.values()){
  const row='| `'+name.replaceAll('`','')+'` | `'+version+'` |';
  if(!notice.includes(row)) missing.push(`${name}@${version}`);
}
const unresolved=(notice.match(/SEE PACKAGE METADATA/g)||[]).length;
const noticeHtml=fs.readFileSync(path.join(root,'public/third-party-notices.html'),'utf8');
if(/SEE PACKAGE METADATA|metadata review/i.test(noticeHtml)) problems.push('public third-party notices contains stale unresolved-license text');
const htmlRows=(noticeHtml.match(/<tr><td>/g)||[]).length;
const htmlPairs=new Set();
for(const m of noticeHtml.matchAll(/<tr><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g)) htmlPairs.add(`${m[1]}@${m[2]}`);
const publicMissing=[...packages.keys()].filter(k=>!htmlPairs.has(k));
if(publicMissing.length) problems.push(`public third-party notices is missing ${publicMissing.length} lockfile package entries`);
const publicExtras=[...htmlPairs].filter(k=>!packages.has(k));
if(publicExtras.length) problems.push(`public third-party notices contains ${publicExtras.length} entries not represented in package-lock.json`);
const result={ok:missing.length===0&&unresolved===0&&problems.length===0,packagesChecked:packages.size,missingNoticeRows:missing,unresolvedLicensePlaceholders:unresolved,publicHtmlRows:htmlRows,publicHtmlUniqueEntries:htmlPairs.size,publicMissingEntries:publicMissing,publicExtraEntries:publicExtras,problems};
console.log(JSON.stringify(result,null,2));
process.exitCode=result.ok?0:1;
