// Disposable Windows CI only: exercise the real published updater through WebView2.
import {spawn,spawnSync} from 'node:child_process';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import path from 'node:path';
if(process.platform!=='win32'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted')throw Error('Disposable hosted Windows runner required');
const version='0.1.6',previousVersion='0.1.5',previousHash='88dca54c978a2aab649ba30b66215d48e65866a612e347588ec04089d8f72f14';
const expectedHash=process.env.FUTCALL_EXPECTED_INSTALLER_SHA256;
if(!/^[a-f0-9]{64}$/.test(expectedHash??''))throw Error('Expected reviewed installer checksum is required');
const base=path.join(process.env.RUNNER_TEMP,'FutCall-native-update-'+randomBytes(5).toString('hex'));
const install=path.join(base,'app'),exe=path.join(install,'futcall-desktop.exe');
const appData=path.join(process.env.LOCALAPPDATA,'app.futcall.desktop'),theme=path.join(appData,'theme.json');
for(const dir of [appData,path.join(process.env.APPDATA,'app.futcall.desktop')]){try{await access(dir);throw Error('Existing application data: clean runner required')}catch(e){if(e.code!=='ENOENT')throw e}}
function ps(script){const r=spawnSync('pwsh',['-NoProfile','-Command',"$ErrorActionPreference='Stop'; "+script],{encoding:'utf8',shell:false});if(r.status!==0)throw Error('Windows process verification failed');return r.stdout.trim()}
if(JSON.parse(ps("ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter \"Name='futcall-desktop.exe'\" | Select-Object ProcessId) -Compress")).length)throw Error('Existing FutCall process');
await mkdir(base,{recursive:true});
const installer=path.join(base,'previous-setup.exe');
const response=await fetch(`https://github.com/quentinvdlpro/FutCall-releases/releases/download/v${previousVersion}/FutCall_${previousVersion}_x64-setup.exe`,{signal:AbortSignal.timeout(180000)});
if(!response.ok)throw Error('Previous public installer unavailable');
const bytes=Buffer.from(await response.arrayBuffer());if(createHash('sha256').update(bytes).digest('hex')!==previousHash)throw Error('Previous installer checksum mismatch');await writeFile(installer,bytes);
const installed=spawnSync(installer,['/S',`/D=${install}`],{timeout:240000,shell:false});if(installed.status!==0)throw Error('Previous installer failed');
let configuration=JSON.parse(await readFile(path.join(install,'public-config.json')));if(configuration.version!==previousVersion)throw Error('Previous installed version mismatch');
await mkdir(appData,{recursive:true});await writeFile(theme,'"light"\n');
const marker=randomBytes(16).toString('hex'),markerPath=path.join(appData,'native-update-fixture.json');await writeFile(markerPath,JSON.stringify({marker}));
const port=19226;let child,connection;
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function retry(operation,timeout=90000){const until=Date.now()+timeout;let last;while(Date.now()<until){try{const value=await operation();if(value)return value}catch(e){last=e}await wait(500)}throw Error('Verification timed out: '+(last?.message??'condition not satisfied'))}
async function connect(){const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`,{signal:AbortSignal.timeout(2000)})).json();const target=targets.find(t=>t.type==='page'&&/^http:\/\/127\.0\.0\.1:\d+\//.test(t.url));if(!target)return null;const ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((res,rej)=>{ws.addEventListener('open',res,{once:true});ws.addEventListener('error',rej,{once:true})});let id=0;const pending=new Map();ws.addEventListener('message',event=>{const m=JSON.parse(String(event.data));const callback=pending.get(m.id);if(callback){pending.delete(m.id);m.error?callback.reject(Error('CDP request failed')):callback.resolve(m.result)}});ws.addEventListener('close',()=>{for(const p of pending.values())p.reject(Error('WebView restarted'));pending.clear()});return{url:target.url,close:()=>ws.close(),async evaluate(expression,awaitPromise=true){const response=await new Promise((resolve,reject)=>{const requestId=++id;const timer=setTimeout(()=>{pending.delete(requestId);reject(Error('CDP timeout'))},30000);pending.set(requestId,{resolve:v=>{clearTimeout(timer);resolve(v)},reject:e=>{clearTimeout(timer);reject(e)}});ws.send(JSON.stringify({id:requestId,method:'Runtime.evaluate',params:{expression,awaitPromise,returnByValue:true}}))});if(response.exceptionDetails)throw Error('Application evaluation failed');return response.result.value}}}
try{
 child=spawn(exe,[],{env:{...process.env,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`},stdio:'ignore',shell:false});
 connection=await retry(connect);await retry(()=>connection.evaluate("Boolean(window.__TAURI_INTERNALS__ && document.querySelector('h1'))"));
 const detected=await connection.evaluate("window.__TAURI_INTERNALS__.invoke('desktop_check_update')");if(!detected.configured||detected.version!==version)throw Error('Real updater did not discover requested release');
 await retry(()=>connection.evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Update and restart'&&!b.disabled)"));
 const originalUrl=connection.url,originalPid=child.pid;
 const oldSidecars=JSON.parse(ps("ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process -Filter \"Name='futcall-node.exe'\" | Select-Object ProcessId) -Compress")).map(p=>p.ProcessId);
 if(!await connection.evaluate("(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Update and restart'&&!b.disabled);if(!b)return false;b.click();return true})()"))throw Error('Update button not usable');
 await retry(async()=>{const c=JSON.parse(await readFile(path.join(install,'public-config.json')));return c.version===version},240000);
 connection.close();connection=await retry(async()=>{const candidate=await connect();if(!candidate)return null;if(candidate.url===originalUrl){candidate.close();return null}return candidate},120000);
 await retry(()=>connection.evaluate("Boolean(window.__TAURI_INTERNALS__ && document.querySelector('h1'))"));
 const current=await connection.evaluate("window.__TAURI_INTERNALS__.invoke('desktop_check_update')");if(!current.configured||current.version!==null)throw Error('Updated application does not report current version');
 const processes=JSON.parse(ps("ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('futcall-desktop.exe','futcall-node.exe')} | Select-Object Name,ProcessId,ExecutablePath) -Compress"));
 const apps=processes.filter(p=>p.Name==='futcall-desktop.exe');if(apps.length!==1||apps[0].ProcessId===originalPid||apps[0].ExecutablePath.toLowerCase()!==exe.toLowerCase())throw Error('Application did not restart in the original installation');
 if(processes.some(p=>oldSidecars.includes(p.ProcessId)))throw Error('Previous sidecar was not stopped');
 if((await readFile(theme,'utf8')).trim()!=='"light"'||JSON.parse(await readFile(markerPath)).marker!==marker)throw Error('Application data did not survive update');
 const manifest=await(await fetch('https://github.com/quentinvdlpro/FutCall-releases/releases/latest/download/latest.json')).json();if(manifest.version!==version)throw Error('Public channel changed during verification');
 const published=await fetch(manifest.platforms['windows-x86_64-nsis'].url,{signal:AbortSignal.timeout(180000)});if(!published.ok||createHash('sha256').update(Buffer.from(await published.arrayBuffer())).digest('hex')!==expectedHash)throw Error('Updater source differs from reviewed public installer');
 const report={passed:true,previousVersion,version,realNativeUpdater:true,detectedAutomatically:true,updateButtonClicked:true,downloadAndSignatureVerification:true,restarted:true,oldSidecarStopped:true,latestVersionConfirmed:true,themePreserved:true,dataMarkerPreserved:true,sameInstallation:true,publicInstallerSha256:expectedHash,runId:process.env.GITHUB_RUN_ID,checkedAt:new Date().toISOString()};
 console.log('FUTCALL_NATIVE_UPDATE_VERIFIED '+JSON.stringify(report));
}finally{
 connection?.close();
 ps("Get-CimInstance Win32_Process | Where-Object {$_.Name -in @('futcall-desktop.exe','futcall-node.exe')} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }");
}
