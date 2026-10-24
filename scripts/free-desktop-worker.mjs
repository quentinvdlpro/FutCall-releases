import { createHash, createDecipheriv, createCipheriv, randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, appendFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const input = JSON.parse(process.env.FUTCALL_BUILD_INPUT);
if (!/^[a-f0-9]{40}$/.test(input.sourceSha) || !/^[a-f0-9]{64}$/.test(input.archiveSha256) || input.version !== '0.1.16') throw new Error('Invalid reviewed build input.');
const key = Buffer.from(process.env.FUTCALL_SOURCE_KEY ?? '', 'base64');
const githubToken = process.env.GH_TOKEN;
delete process.env.FUTCALL_SOURCE_KEY;
delete process.env.GH_TOKEN;
if (!/^candidate-v0\.1\.16-[a-f0-9]+$/.test(input.candidateTag)) throw new Error('Invalid candidate tag.');
if (key.length !== 32 || !githubToken) throw new Error('Missing scoped build input configuration.');
const targets = {'darwin:arm64':'aarch64-apple-darwin','darwin:x64':'x86_64-apple-darwin','win32:x64':'x86_64-pc-windows-msvc'};
const target = targets[`${process.platform}:${process.arch}`];
if (!target) throw new Error('Unsupported native runner.');
const workspace = path.join(process.env.RUNNER_TEMP, `futcall-${target}`);
const source = path.join(workspace, 'source');
const outputs = path.join(workspace, 'outputs');
await mkdir(source, {recursive:true});
await mkdir(outputs, {recursive:true});
const log = path.join(workspace, 'build.log');
const proof = {schemaVersion:1, sourceSha:input.sourceSha, archiveSha256:input.archiveSha256, version:input.version, target, repository:process.env.GITHUB_REPOSITORY, runId:process.env.GITHUB_RUN_ID, workflowSha:process.env.GITHUB_SHA, passed:false, validations:[], assets:{}};
const buildEnvironment = {...process.env, FUTCALL_DESKTOP_TARGET:target, FUTCALL_DISTRIBUTION:'1', FUTCALL_SIGNED_BUILD:'0', FUTCALL_UPDATER_BUILD:'0', NEXT_TELEMETRY_DISABLED:'1'};
function run(stage, executable, args, cwd=source) {
  const result=spawnSync(executable,args,{cwd,env:buildEnvironment,encoding:'utf8',shell:false,maxBuffer:128*1024*1024});
  return appendFile(log, `\n[${stage}]\n${result.stdout??''}${result.stderr??''}`).then(()=>{
    if(result.error || result.status!==0) throw new Error(`${stage} failed.`);
    proof.validations.push(stage);
    console.log(`Passed: ${stage}`);
    return result.stdout;
  });
}
async function download(url,destination) {
  const parsed=new URL(url);
  if(parsed.protocol!=='https:' || parsed.hostname!=='github.com' || !parsed.pathname.startsWith('/quentinvdlpro/FutCall-releases/releases/download/')) throw new Error('Unreviewed asset URL.');
  const response=await fetch(url,{signal:AbortSignal.timeout(180000)});
  if(!response.ok) throw new Error('Asset download failed.');
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}
let successful=false;
try {
  const encryptedFile=path.join(workspace,'source.enc');
  await download(input.sourceUrl,encryptedFile);
  const encrypted=await readFile(encryptedFile);
  if(createHash('sha256').update(encrypted).digest('hex')!==input.archiveSha256) throw new Error('Source ciphertext checksum mismatch.');
  const decipher=createDecipheriv('aes-256-gcm',key,encrypted.subarray(0,12));
  decipher.setAAD(Buffer.from(input.sourceSha));
  decipher.setAuthTag(encrypted.subarray(12,28));
  const archive=Buffer.concat([decipher.update(encrypted.subarray(28)),decipher.final()]);
  const archivePath=path.join(workspace,'source.tar.gz');
  await writeFile(archivePath,archive);
  await run('decrypt reviewed source','tar',['-xzf',archivePath,'-C',source],workspace);
  const packageJson=JSON.parse(await readFile(path.join(source,'package.json'),'utf8'));
  if(packageJson.version!==input.version) throw new Error('Source version mismatch.');
  const candidates=[path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')];
  let npm;
  for(const candidate of candidates) {try {await access(candidate); npm=candidate; break;} catch {}}
  if(!npm) throw new Error('Pinned npm runtime not found.');
  await run('verify reviewed release source',process.execPath,['scripts/desktop/verify-release-content.mjs']);
  await run('install locked dependencies',process.execPath,[npm,'ci']);
  for(const script of ['typecheck','lint','test','test:database:sales']) await run(script,process.execPath,[npm,'run',script]);
  await run('desktop runtime tests',process.execPath,['--test','scripts/desktop/runtime.test.mjs','scripts/desktop/details-observer.test.mjs','scripts/desktop/release-manifest.test.mjs']);
  await run('prepare desktop resources',process.execPath,[npm,'run','desktop:prepare']);
  await run('locked Rust tests',process.execPath,[npm,'run','desktop:test']);
  await run('build native installers',process.execPath,[npm,'run','desktop:build']);
  await run('verify compiled release features',process.execPath,['scripts/desktop/verify-release-content.mjs','--bundle','src-tauri/resources/server']);
  const bundle=path.join(source,'src-tauri/target',target,'release/bundle');
  if(process.platform==='win32') {
    const nsis=path.join(bundle,'nsis',`FutCall_${input.version}_x64-setup.exe`);
    const report=path.join(outputs,'windows-smoke.json');
    await run('Windows installed package', 'pwsh',['-NoProfile','-File','scripts/desktop/windows-smoke.ps1','-InstallerPath',nsis,'-OutputPath',report]);
    const installed=JSON.parse(await readFile(report,'utf8'));
    if(installed.passed!==true || installed.uninstalled!==true || installed.sidecarStopped!==true) throw new Error('Fresh Windows fixture did not complete safely.');
    await run('cleanup Windows smoke fixture','pwsh',['-NoProfile','-Command',`
      $ErrorActionPreference = 'Stop'
      if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable Windows runner required.' }
      $fixturePaths = @((Join-Path $env:LOCALAPPDATA 'app.futcall.desktop'), (Join-Path $env:APPDATA 'app.futcall.desktop'))
      $deadline = [DateTime]::UtcNow.AddSeconds(45)
      do {
        foreach ($fixturePath in $fixturePaths) {
          if (Test-Path -LiteralPath $fixturePath) { Remove-Item -LiteralPath $fixturePath -Recurse -Force -ErrorAction SilentlyContinue }
        }
        if (!@($fixturePaths | Where-Object { Test-Path -LiteralPath $_ }).Count) { break }
        Start-Sleep -Milliseconds 500
      } while ([DateTime]::UtcNow -lt $deadline)
      if (@($fixturePaths | Where-Object { Test-Path -LiteralPath $_ }).Count) { throw 'Windows fixture cleanup was still locked.' }
    `]);
    const previous=path.join(workspace,'previous');
    await mkdir(previous);
    for(const name of ['FutCaller_0.1.2_x64-setup.exe','FutCaller_0.1.2_x64-setup.exe.sig']) await download(`https://github.com/quentinvdlpro/FutCall-releases/releases/download/v0.1.2/${name}`,path.join(previous,name));
    await run('verify previous signed installer',process.execPath,['scripts/desktop/verify-upgrade-fixture.mjs',previous]);
    await run('Windows upgrade from 0.1.2','pwsh',['-NoProfile','-File','scripts/desktop/windows-smoke.ps1','-InstallerPath',nsis,'-PreviousInstallerPath',path.join(previous,'FutCaller_0.1.2_x64-setup.exe'),'-OutputPath',path.join(outputs,'windows-upgrade.json')]);
    for(const folder of ['nsis','msi']) for(const name of await readdir(path.join(bundle,folder))) if(name.endsWith('.exe')||name.endsWith('.msi')) await writeFile(path.join(outputs,name),await readFile(path.join(bundle,folder,name)));
  } else {
    const app=path.join(bundle,'macos/FutCall.app');
    await run('verify macOS bundle signature','codesign',['--verify','--deep','--strict',app]);
    const version=(await run('verify macOS app version','/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(app,'Contents/Info.plist')])).trim();
    const architecture=(await run('verify macOS architecture','lipo',['-archs',path.join(app,'Contents/MacOS/futcall-desktop')])).trim();
    if(version!==input.version || architecture!==(process.arch==='arm64'?'arm64':'x86_64')) throw new Error('Native package identity mismatch.');
    const arch=process.arch==='arm64'?'aarch64':'x86_64';
    await run('create macOS updater archive','tar',['-czf',path.join(outputs,`FutCall_${input.version}_${arch}.app.tar.gz`),'-C',path.dirname(app),'FutCall.app']);
    for(const name of await readdir(path.join(bundle,'dmg'))) if(name.endsWith('.dmg')) await writeFile(path.join(outputs,name),await readFile(path.join(bundle,'dmg',name)));
  }
  for(const name of await readdir(outputs)) proof.assets[name]={sha256:createHash('sha256').update(await readFile(path.join(outputs,name))).digest('hex')};
  proof.passed=true;
  successful=true;
} catch(error) {
  await appendFile(log,`\n${error.stack}\n`);
  console.error(`Desktop build failed on ${target}; encrypted diagnostics were prepared.`);
} finally {
  const plain=await readFile(log).catch(()=>Buffer.from('Build failed before diagnostics were available.'));
  const nonce=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,nonce);
  cipher.setAAD(Buffer.from(`logs:${input.sourceSha}:${target}`));
  const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
  await writeFile(path.join(outputs,`${target}-diagnostics.enc`),Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]));
  await writeFile(path.join(outputs,`${target}-provenance.json`),JSON.stringify(proof,null,2)+'\n');
  const names=await readdir(outputs);
  const upload=spawnSync('gh',['release','upload',input.candidateTag,...names.map(name=>path.join(outputs,name)),'--repo','quentinvdlpro/FutCall-releases'],{env:{...process.env,GH_TOKEN:githubToken},encoding:'utf8',shell:false,maxBuffer:8*1024*1024});
  if(upload.status!==0) {console.error('Candidate upload failed.');successful=false;}
  key.fill(0);
}
process.exitCode=successful?0:1;
