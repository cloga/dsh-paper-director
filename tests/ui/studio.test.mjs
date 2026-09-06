import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { chromium } from './.deps/node_modules/playwright/index.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OUT = path.join(ROOT, 'tests/ui/.artifacts');
// Loopback is a secure context for browser crypto/media APIs. Every request is fulfilled
// by Playwright routing: nothing listens on this port and no server is started.
const ORIGIN = 'http://127.0.0.1:3999';
const initial = () => ({ id: 'project-one', revision: 1, title: '我的纸上故事', story: '', credits: { director: '', voice: '' },
  characters: [{ id: 'hero', name: '纸偶', color: '#ac4866' }, { id: 'clock', name: '时钟', color: '#317a72' }],
  scenes: [], assets: [], recordingAssetId: null, alignment: null, exports: [], edits: [], style: { width: 1280, height: 960, fps: 25, introSeconds: 3, outroSeconds: 4 } });
function syntheticPng() {
  // CC0 anonymous geometric puppet, encoded with Node builtins; no downloaded/private image.
  const width = 300, height = 240, raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let rgb = y > 180 ? [127, 168, 115] : [242, 224, 182];
    if ((x - 245) ** 2 + (y - 49) ** 2 < 32 ** 2) rgb = [243, 195, 77];
    if (y > 90 && y < 210 && Math.abs(x - 90) < (y - 65) * .4) rgb = [67, 137, 194];
    if ((x - 90) ** 2 + (y - 75) ** 2 < 25 ** 2) rgb = [255, 246, 220];
    if ((x - 82) ** 2 + (y - 74) ** 2 < 2 ** 2 || (x - 99) ** 2 + (y - 74) ** 2 < 2 ** 2) rgb = [53, 57, 69];
    if (x > 205 && x < 246 && y > 120 && y < 185) rgb = [182, 119, 76];
    if ((x - 226) ** 2 + (y - 143) ** 2 < 14 ** 2) rgb = [255, 246, 220];
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    raw[offset] = rgb[0]; raw[offset + 1] = rgb[1]; raw[offset + 2] = rgb[2];
  }
  const chunk = (type, data) => {
    const name = Buffer.from(type), all = Buffer.concat([name, data]); let crc = 0xffffffff;
    for (const byte of all) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); all.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function wav() {
  const rate = 8000, count = rate * 4, data = Buffer.alloc(44 + count * 2);
  data.write('RIFF', 0); data.writeUInt32LE(36 + count * 2, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) data.writeInt16LE(Math.round(Math.sin(i * Math.PI * 2 * 330 / rate) * 2000), 44 + i * 2);
  return data;
}
async function setup(browser, synthesizeMicrophone = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  if (synthesizeMicrophone) await context.addInitScript(() => {
    // Real browser MediaRecorder receives a generated oscillator stream, never a microphone.
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {
      const audio = new AudioContext();
      const source = audio.createOscillator(), gain = audio.createGain(), destination = audio.createMediaStreamDestination();
      source.frequency.value = 440; gain.gain.value = .1; source.connect(gain); gain.connect(destination); source.start();
      await audio.resume(); window.syntheticAudioContext = audio; return destination.stream;
    } });
  });
  const page = await context.newPage();
  const state = { project: null, jobs: [], requests: [], errors: [], conflict: false, serial: 0, keepRunning: false,
    agentError: false, health: { render: { ready: true }, alignment: { configured: false, engine: '' }, agent: { configured: false }, narration: { configured: false }, worker: { available: true, missing: [] } } };
  page.on('pageerror', error => state.errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  const png = syntheticPng();
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== ORIGIN) return route.abort();
    const pathname = url.pathname;
    if (pathname === '/paper-director/' || pathname.startsWith('/paper-director/static/')) {
      const name = pathname === '/paper-director/' ? 'index.html' : pathname.split('/').at(-1);
      if (!['index.html', 'studio.js', 'studio.css'].includes(name)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ status: 200, contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body: await readFile(path.join(ROOT, 'web', name)) });
    }
    const endpoint = pathname.replace('/paper-director/api', '');
    const method = request.method();
    let body = null;
    if (request.headers()['content-type']?.includes('application/json')) body = request.postDataJSON();
    state.requests.push({ endpoint, method, body, headers: request.headers(), bytes: request.postDataBuffer()?.length });
    const ok = data => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
    const error = (code, status = 400) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code, message: 'Untrusted internal C:/secret/key path must not be displayed' } }) });
    if (endpoint === '/health') return ok(state.health);
    if (endpoint === '/projects' && method === 'GET') return ok(state.project ? [state.project] : []);
    if (endpoint === '/projects' && method === 'POST') { state.project = initial(); return ok(state.project); }
    if (endpoint === '/projects/project-one' && method === 'GET') return ok(state.project);
    if (endpoint === '/projects/project-one' && method === 'PATCH') {
      if (state.conflict) { state.conflict = false; state.project.title = '另一处保存的新版本'; state.project.revision++; return error('REVISION_CONFLICT', 409); }
      if (body.expectedRevision !== state.project.revision) return error('REVISION_CONFLICT', 409);
      Object.assign(state.project, body.patch); state.project.revision++;
      if (['scenes', 'characters', 'recordingAssetId'].some(key => key in body.patch)) state.project.alignment = null;
      return ok(state.project);
    }
    if (endpoint === '/projects/project-one/assets' && method === 'POST') {
      assert.equal(Number(request.headers()['x-project-revision']), state.project.revision);
      if (state.uploadFailure) { state.uploadFailure = false; return error('UPLOAD_FAILED', 503); }
      const kind = request.headers()['x-asset-kind'];
      const asset = { id: `asset-${++state.serial}`, kind, name: decodeURIComponent(request.headers()['x-file-name']), mime: request.headers()['content-type'], metadata: kind === 'audio' ? { duration: 4 } : { width: 300, height: 240 } };
      state.project.assets.push(asset); state.project.revision++;
      return ok({ project: state.project, asset });
    }
    if (endpoint.startsWith('/projects/project-one/assets/')) {
      const asset = state.project.assets.find(a => a.id === endpoint.split('/').at(-1));
      const buffer = asset?.kind === 'audio' ? wav() : png;
      const range = request.headers().range;
      if (range) { const start = Number(range.match(/bytes=(\d+)/)?.[1] || 0); return route.fulfill({ status: 206, headers: { 'Content-Type': asset?.mime || 'image/png', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${buffer.length - 1}/${buffer.length}` }, body: buffer.subarray(start) }); }
      return route.fulfill({ status: 200, headers: { 'Content-Type': asset?.mime || 'image/png', 'Accept-Ranges': 'bytes' }, body: buffer });
    }
    if (endpoint === '/jobs') {
      for (const job of state.jobs) if (job.status === 'running' && !state.keepRunning) {
        job.status = 'succeeded'; job.progress = 1;
        if (job.kind === 'align') {
          const segments = job.segments || state.project.scenes.flatMap(s => s.dialogue.map((d, i) => ({ dialogueId: d.id, start: i, end: i + .6, text: d.text })));
          state.project.alignment = { method: job.segments ? 'provided_segments' : 'local_whisper', duration: 4,
            utterances: state.project.scenes.flatMap(s => s.dialogue.map(d => { const part = segments.find(v => v.dialogueId === d.id); return { dialogueId: d.id, sceneId: s.id, characterId: d.characterId, recognizedText: part?.text || '', start: part?.start ?? null, end: part?.end ?? null, matchStatus: part ? 'matched' : 'unmatched' }; })),
            unmatchedSpeech: segments.filter(s => !s.dialogueId), warnings: ['Provided transcript is not ASR'] };
        } else if (job.kind === 'render') {
          const asset = { id: `movie-${++state.serial}`, kind: 'video', mime: 'video/mp4', metadata: {} };
          state.project.assets.push(asset); job.result = { assetId: asset.id, preview: true, inputRevision: job.revision, applied: true };
          state.project.exports.push(job.result);
        }
        state.project.revision++;
      }
      return ok(state.jobs);
    }
    if (/\/jobs\/[^/]+\/cancel$/.test(endpoint)) { const job = state.jobs.find(j => endpoint.includes(j.id)); job.status = 'cancelled'; return ok(job); }
    if (/\/projects\/project-one\/(align|render)$/.test(endpoint)) {
      const kind = endpoint.split('/').at(-1), job = { id: `job-${++state.serial}`, projectId: state.project.id, kind, revision: body.expectedRevision, status: 'running', progress: .2, stage: 'working', result: null, error: null };
      if (body.segments) job.segments = body.segments;
      state.jobs.unshift(job); return ok(job);
    }
    if (endpoint === '/projects/project-one/agent') return state.agentError ? error('AGENT_NOT_CONFIGURED') : ok({ sessionId: 'agent-session-one' });
    if (endpoint.endsWith('/history')) return ok([{ revision: state.project.revision }, { revision: 1 }]);
    if (endpoint.endsWith('/restore')) { state.project.title = '恢复的第一部故事'; state.project.revision++; return ok(state.project); }
    return error('NOT_FOUND', 404);
  });
  await page.goto(ORIGIN + '/paper-director/');
  await page.locator('#new-project').waitFor();
  return { page, context, state, png };
}

await mkdir(OUT, { recursive: true });
const launch = process.env.PAPER_DIRECTOR_BROWSER ? { executablePath: process.env.PAPER_DIRECTOR_BROWSER } : process.platform === 'win32' ? { channel: 'msedge' } : {};
const browser = await chromium.launch({ ...launch, headless: true, args: ['--disable-background-networking'] });

test('child studio: authored story → ordered photos → ONE recording → explicit manual markers → actual jobs and feedback', async () => {
  const { page, context, state, png } = await setup(browser);
  await page.locator('#new-project').click();
  await page.locator('#editor').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#agent-create').isDisabled(), true);
  assert.equal(await page.locator('#auto-align').isDisabled(), true);
  await page.locator('#title').fill('纸偶与时间之门');
  await page.locator('#story').fill('纸偶寻找时钟里的秘密，打开一扇时间门。');
  await page.locator('#director').fill('匿名小导演');
  await page.locator('#voice').fill('合成演示');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存');
  assert.equal(state.project.title, '纸偶与时间之门');
  await page.waitForFunction(() => !document.getElementById('photo-files').disabled);
  await page.locator('#photo-files').setInputFiles([{ name: 'anonymous-a.png', mimeType: 'image/png', buffer: png }, { name: 'anonymous-b.png', mimeType: 'image/png', buffer: png }]);
  await page.waitForFunction(() => document.querySelectorAll('.scene').length === 2 && !document.getElementById('photo-files').disabled);
  const originalIds = state.project.scenes.map(s => s.id);
  await page.getByRole('button', { name: '第2幕向前移' }).click();
  const firstScene = page.locator('.scene').first();
  await firstScene.getByRole('button', { name: '＋ 加一句台词' }).click();
  await firstScene.getByLabel('这句台词', { exact: true }).fill('时间之门在哪里？');
  await firstScene.getByLabel('怎么说').selectOption('thought');
  await firstScene.getByLabel('这里发生了什么动作？').fill('轻轻打开时钟的小门。');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存');
  assert.deepEqual(state.project.scenes.map(s => s.id), originalIds.toReversed());
  const dialogueId = state.project.scenes[0].dialogue[0].id;
  assert.match(dialogueId, /^[A-Za-z0-9_-]+$/);
  await page.waitForFunction(() => !document.getElementById('audio-file').disabled);
  await page.locator('#audio-file').setInputFiles({ name: 'anonymous-tones.wav', mimeType: 'audio/wav', buffer: wav() });
  await page.waitForFunction(() => !document.getElementById('recording-player').hidden && !document.getElementById('audio-file').disabled);
  assert.ok(state.project.recordingAssetId);
  const audioPatches = state.requests.filter(r => r.body?.patch?.recordingAssetId);
  assert.equal(audioPatches.length, 1, 'one complete recording association, never per-scene recordings');
  await page.locator('#manual-markers summary').click();
  const row = page.locator('[data-marker-id]').first();
  await row.getByLabel('开始（秒）', { exact: true }).fill('0.2');
  await row.getByLabel('结束（秒）', { exact: true }).fill('1.4');
  await page.locator('#add-extra-marker').click();
  await page.getByLabel('额外说了什么').fill('这里还有一句额外的话');
  await page.getByLabel('额外话开始（秒）', { exact: true }).fill('2');
  await page.getByLabel('额外话结束（秒）', { exact: true }).fill('2.6');
  await page.locator('#submit-markers').click();
  await page.waitForFunction(() => !document.getElementById('preview').disabled, { timeout: 10000 });
  const manual = state.requests.find(r => r.endpoint.endsWith('/align') && r.method === 'POST');
  assert.equal(manual.body.engine, 'segments');
  assert.equal(manual.body.segments[0].dialogueId, dialogueId);
  assert.equal(manual.body.segments[0].text, '时间之门在哪里？');
  assert.equal(manual.body.segments[1].dialogueId, undefined);
  assert.match(await page.locator('#alignment-status').innerText(), /人工.*不是自动/);
  await page.locator('#preview').click();
  await page.locator('#movie-player').waitFor({ state: 'visible', timeout: 10000 });
  assert.match(await page.locator('#movie-player').getAttribute('src'), /^\/paper-director\/api\/projects\/project-one\/assets\/movie-/);
  assert.equal(state.requests.filter(r => r.endpoint.endsWith('/agent')).length, 0, 'direct render is not represented as agent work');
  state.health.agent.configured = true; state.health.alignment.configured = true;
  await page.locator('#refresh-health').click();
  await page.waitForFunction(() => !document.getElementById('agent-create').disabled);
  await page.locator('#agent-prompt').fill('请尊重我的故事，时间旅行加光圈。');
  await page.locator('#agent-create').click();
  await page.waitForFunction(() => document.getElementById('agent-status').textContent.includes('已交给导演助手'));
  await page.locator('#feedback').fill('第二张照片多停一会儿。');
  await page.locator('#send-feedback').click();
  await page.waitForFunction(() => !document.getElementById('send-feedback').disabled);
  const agentCalls = state.requests.filter(r => r.endpoint.endsWith('/agent'));
  assert.equal(agentCalls.length, 2); assert.equal(agentCalls[1].body.prompt, '第二张照片多停一会儿。');
  await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
  await page.screenshot({ path: path.join(OUT, 'studio-desktop.png'), fullPage: true });
  await page.screenshot({ path: path.join(OUT, 'studio-desktop-top.png'), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(OUT, 'studio-mobile.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile page has no horizontal overflow');
  assert.deepEqual(state.errors, []);
  await context.close();
});

test('truthful errors, conflict protection, job cancellation, restore and text-only rendering', async () => {
  const { page, context, state } = await setup(browser);
  await page.locator('#new-project').click(); await page.locator('#editor').waitFor({ state: 'visible' });
  await page.locator('#title').fill('<img src=x onerror="window.pwned=1">');
  await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('save-state').textContent === '已保存');
  assert.equal(await page.evaluate(() => window.pwned), undefined);
  assert.equal(await page.locator('#project-title img').count(), 0);
  assert.match(await page.locator('#project-title').innerText(), /<img/);
  state.conflict = true;
  await page.locator('#title').fill('我的旧版本不能覆盖别人'); await page.locator('#save').click();
  await page.waitForFunction(() => document.getElementById('title').value === '另一处保存的新版本');
  assert.match(await page.locator('#notice').innerText(), /没有覆盖/);
  state.health.agent.configured = true; state.agentError = true;
  await page.locator('#refresh-health').click(); await page.waitForFunction(() => !document.getElementById('agent-create').disabled);
  await page.locator('#agent-create').click();
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('导演助手还没有接好'));
  assert.doesNotMatch(await page.locator('body').innerText(), /C:\/secret|key path/);
  state.project.recordingAssetId = 'recording'; state.project.assets.push({ id: 'recording', kind: 'audio', mime: 'audio/wav', metadata: { duration: 4 } });
  state.project.scenes.push({ id: 'scene-one', imageAssetId: null, action: '', dialogue: [{ id: 'line-one', characterId: 'hero', text: '你好', mode: 'normal' }], transition: 'cut', timeLabel: '' });
  state.project.alignment = { duration: 4, method: 'provided_segments', utterances: [{ dialogueId: 'line-one', start: null, end: null, matchStatus: 'unmatched', recognizedText: '' }], unmatchedSpeech: [], warnings: [] };
  await page.locator('.project-card').click();
  assert.equal(await page.locator('#preview').isDisabled(), true, 'unmatched null dialogue blocks render');
  state.health.alignment.configured = true; state.keepRunning = true;
  await page.locator('#refresh-health').click(); await page.waitForFunction(() => !document.getElementById('auto-align').disabled);
  await page.locator('#auto-align').click();
  await page.getByRole('button', { name: '取消任务' }).click();
  await page.waitForFunction(() => document.getElementById('jobs').textContent.includes('已取消'));
  const auto = state.requests.find(r => r.endpoint.endsWith('/align') && r.method === 'POST');
  assert.equal(Object.hasOwn(auto.body, 'engine'), false, 'host chooses configured auto engine');
  await page.locator('.history summary').click(); await page.locator('#load-history').click();
  await page.getByRole('button', { name: '恢复为新版本' }).click();
  await page.waitForFunction(() => document.getElementById('title').value === '恢复的第一部故事');
  assert.ok(state.requests.some(r => r.endpoint.endsWith('/restore') && Number.isInteger(r.body.expectedRevision)));
  const allFetchRequests = state.requests.filter(r => !r.endpoint.includes('/assets/'));
  assert.ok(allFetchRequests.length > 5);
  assert.deepEqual(state.errors, []);
  await context.close();
});

test('real MediaRecorder captures one synthetic stream and retains it when upload fails', async () => {
  const { page, context, state } = await setup(browser, true);
  await page.locator('#new-project').click(); await page.locator('#editor').waitFor({ state: 'visible' });
  await page.locator('#start-recording').click();
  await page.locator('#stop-recording').waitFor({ state: 'visible' });
  await page.waitForFunction(() => window.syntheticAudioContext?.currentTime > .4);
  state.uploadFailure = true;
  await page.locator('#stop-recording').click();
  await page.waitForFunction(() => !document.getElementById('retry-recording').hidden && !document.getElementById('retry-recording').disabled);
  assert.match(await page.locator('#recording-player').getAttribute('src'), /^blob:/);
  assert.match(await page.locator('#recording-info').innerText(), /尚未成功保存/);
  assert.equal(state.project.recordingAssetId, null);
  await page.locator('#retry-recording').click();
  await page.waitForFunction(() => document.getElementById('retry-recording').hidden && !document.getElementById('audio-file').disabled);
  assert.ok(state.project.recordingAssetId);
  const uploads = state.requests.filter(r => r.method === 'POST' && r.endpoint.endsWith('/assets'));
  assert.equal(uploads.length, 2, 'retry reuses same recording rather than recording each scene again');
  assert.ok(uploads[0].bytes > 100); assert.equal(uploads[0].bytes, uploads[1].bytes);
  assert.match(uploads[1].headers['content-type'], /^audio\//);
  assert.equal(state.requests.filter(r => r.body?.patch?.recordingAssetId).length, 1);
  await page.evaluate(() => {
    const player = document.getElementById('recording-player');
    window.otherPlayerPaused = 0;
    player.pause = () => { window.otherPlayerPaused++; };
    document.getElementById('movie-player').dispatchEvent(new Event('play', { bubbles: false }));
  });
  assert.equal(await page.evaluate(() => window.otherPlayerPaused), 1, 'another media play pauses the existing audio player');
  assert.deepEqual(state.errors, []);
  await context.close();
});

test.after(async () => { await browser.close(); });
