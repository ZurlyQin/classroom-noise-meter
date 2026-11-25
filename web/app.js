'use strict';

const LED_PINS = [2, 3, 4, 5, 6];
const BUZZER_PIN = 8;
const BUZZER_PATTERNS = {
  double: { pulses: [520, 520], gap: 170 },
  triple: { pulses: [240, 240, 240], gap: 130 },
  long: { pulses: [1200], gap: 0 },
};
const SPEAKER_TONES = {
  chime: [[660, 0, 0.32], [880, 0.19, 0.54]],
  ascending: [[440, 0, 0.18], [554, 0.21, 0.18], [740, 0.42, 0.33]],
};
const ALARM_PREFERENCE = 'classroom-noise-meter.alarm-sound';
const CUSTOM_MAX_SECONDS = 3;
const DEFAULT_ALARM_GUARD_MS = 2100;
const MODES = { EXAM: 'Exam', GROUP: 'Group work', BREAK: 'Break' };
const CLIENT = crypto.randomUUID();
const elements = Object.fromEntries(Array.from(document.querySelectorAll('[id]'), element => [element.id, element]));
const modeButtons = Array.from(document.querySelectorAll('[data-mode]'));
const segments = Array.from(elements['led-bar'].children);
const debugLeds = new Map(Array.from(elements['debug-leds'].children, element => [Number(element.dataset.pin), element]));
let state = null;
let input = null;
let busy = false;
let reading = false;
let localMessage = '';
let latestRequest = 0;
let latestAccepted = 0;
let historyKey = '';
let records = [];
let speakerContext;
let customSound = null;
let importingSound = false;
let alarmJob = null;
let debugEnabled = false;
let debugCapture = null;

function pinQueries(pins) {
  return pins.flatMap(pin => [0xf0, 0x6d, pin, 0xf7]);
}

class FirmataDevice {
  constructor(port) {
    this.port = port;
    this.low = 1023;
    this.high = 0;
    this.samples = 0;
    this.selectorEnabled = false;
    this.digital = null;
    this.leds = -1;
    this.buzzerReply = null;
    this.buzzerQueue = Promise.resolve();
    this.buzzerGeneration = 0;
    this.onPinState = null;
    this.debugMic = null;
    this.closing = false;
    this.firmware = null;
    this.sysex = null;
    this.channelStatus = 0;
    this.bytes = [];
  }

  async open() {
    await this.port.open({ baudRate: 57600 });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.readTask = this.read();
    for (let attempt = 0; attempt < 11 && !this.firmware; attempt++) {
      await this.write([0xf0, 0x79, 0xf7]);
      await new Promise(resolve => setTimeout(resolve, 360));
    }
    if (!this.firmware || !/^StandardFirmata(?:\.ino)?$/.test(this.firmware)) {
      throw new Error('StandardFirmata did not respond on this port. Check which USB device you selected.');
    }
    await this.write([
      ...[...LED_PINS, BUZZER_PIN].flatMap(pin => [0xf4, pin, 1, 0xf5, pin, 0]),
      0xf4, 14, 2, 0xf0, 0x7a, 2, 0, 0xf7, 0xc0, 1,
    ]);
    this.initialized = true;
  }

  async read() {
    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        for (const byte of value) this.consume(byte);
      }
    } catch (error) {
      if (!this.closing) this.readError = error;
    } finally {
      this.reader.releaseLock();
      if (!this.closing && input?.device === this) {
        stopInput('USB connection was lost. Reconnect the board to continue.');
      }
    }
  }

  consume(byte) {
    if (byte === 0xf0) {
      this.sysex = [];
      this.channelStatus = 0;
      return;
    }
    if (this.sysex !== null) {
      if (byte === 0xf7) {
        const message = this.sysex;
        this.sysex = null;
        if (message[0] === 0x79 && message.length >= 5) {
          let name = '';
          for (let i = 3; i + 1 < message.length; i += 2) {
            name += String.fromCharCode(message[i] | (message[i + 1] << 7));
          }
          this.firmware = name;
        } else if (message[0] === 0x6e && message.length >= 4) {
          const [, pin, mode, value] = message;
          if (pin === BUZZER_PIN) this.buzzerReply?.(mode, value);
          this.onPinState?.(pin, mode, value);
        }
      } else if (byte < 0x80 && this.sysex.length < 512) {
        this.sysex.push(byte);
      } else {
        this.sysex = null;
      }
      return;
    }
    if (byte >= 0x80) {
      this.channelStatus = byte;
      this.bytes.length = 0;
      return;
    }
    if (this.channelStatus !== 0xe0 && this.channelStatus !== 0x91) return;
    this.bytes.push(byte);
    if (this.bytes.length < 2) return;
    const value = this.bytes[0] | (this.bytes[1] << 7);
    if (this.channelStatus === 0xe0) {
      this.low = Math.min(this.low, value);
      this.high = Math.max(this.high, value);
      this.samples++;
      if (this.debugMic) {
        this.debugMic.low = Math.min(this.debugMic.low, value);
        this.debugMic.high = Math.max(this.debugMic.high, value);
        this.debugMic.samples++;
      }
    } else {
      this.digital = value;
    }
    this.channelStatus = 0;
  }

  frame() {
    if (!this.samples) return null;
    const frame = { low: this.low, high: this.high, selector: -1 };
    if (this.selectorEnabled && this.digital !== null) {
      frame.selector = Number(!(this.digital & 2)) + 2 * Number(!(this.digital & 4));
    }
    this.samples = 0;
    this.low = 1023;
    this.high = 0;
    return frame;
  }

  write(bytes) {
    return this.writer.write(Uint8Array.from(bytes));
  }

  async setSelector(enabled) {
    this.digital = null;
    if (enabled) await this.write([0xf4, 9, 0x0b, 0xf4, 10, 0x0b, 0xd1, 1]);
    else await this.write([0xd1, 0]);
    this.selectorEnabled = enabled;
  }

  async driveLeds(count) {
    if (count === this.leds) return;
    const outputs = LED_PINS.flatMap((pin, index) => [0xf5, pin, Number(index < count)]);
    if (this.onPinState) outputs.push(...pinQueries(LED_PINS));
    await this.write(outputs);
    this.leds = count;
  }

  queryBuzzer(level, includeLeds = false) {
    // Keep diagnostic D8 queries and alarm write/readback pairs in order.
    const pending = this.buzzerQueue.then(() => this.exchangeBuzzer(level, includeLeds));
    this.buzzerQueue = pending.catch(() => {});
    return pending;
  }

  async exchangeBuzzer(level, includeLeds) {
    if (this.closing) throw new Error('Arduino is disconnected.');
    let timeout;
    let lastReply;
    const commands = level === undefined ? [] : [0xf5, BUZZER_PIN, level];
    commands.push(...pinQueries(includeLeds ? [...LED_PINS, BUZZER_PIN] : [BUZZER_PIN]));
    const reply = new Promise((resolve, reject) => {
      this.buzzerReply = (mode, actual) => {
        lastReply = { mode, actual };
        if (level === undefined || (mode === 1 && actual === level)) resolve();
      };
      timeout = setTimeout(() => {
        const detail = lastReply ? `D8 reported ${lastReply.actual} in mode ${lastReply.mode}; expected output ${level}.`
          : 'D8 did not return a pin state.';
        reject(new Error(detail));
      }, level === undefined ? 220 : 650);
    });
    try {
      await Promise.all([reply, this.write(commands)]);
    } finally {
      clearTimeout(timeout);
      this.buzzerReply = null;
    }
  }

  async pulseBuzzer(pattern) {
    const generation = this.buzzerGeneration;
    const running = () => !this.closing && generation === this.buzzerGeneration;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    let finished = false;
    try {
      for (let pulse = 0; pulse < pattern.pulses.length; pulse++) {
        if (!running()) return false;
        await this.queryBuzzer(1);
        await wait(pattern.pulses[pulse]);
        if (!running()) return false;
        await this.queryBuzzer(0);
        if (pulse + 1 < pattern.pulses.length) await wait(pattern.gap);
      }
      finished = true;
      return true;
    } finally {
      if (!finished && running()) {
        try { await this.write([0xf5, BUZZER_PIN, 0]); } catch { /* A disconnected board cannot be addressed. */ }
      }
    }
  }

  stopOutputs() {
    this.buzzerGeneration++;
    if (!this.initialized || !this.writer) return Promise.resolve();
    return this.write([
      ...[BUZZER_PIN, ...LED_PINS].flatMap(pin => [0xf5, pin, 0]),
      0xc0, 0, 0xd1, 0, 0xf0, 0x7a, 19, 0, 0xf7,
    ]);
  }

  async close() {
    this.closing = true;
    try { await this.stopOutputs(); } catch { /* Cable may already be unplugged. */ }
    if (this.reader && this.port.readable?.locked) {
      try { await this.reader.cancel(); } catch { /* Stream may already have failed. */ }
    }
    if (this.readTask) await this.readTask;
    if (this.writer) this.writer.releaseLock();
    if (this.writer || this.reader) {
      try { await this.port.close(); } catch { /* The browser may have closed it. */ }
    }
  }
}

async function request(action, fields = {}) {
  const order = ++latestRequest;
  const params = new URLSearchParams({ client: CLIENT, ...fields });
  if (action !== 'state') params.set('action', action);
  const response = await fetch(`/api/${action === 'state' ? 'state' : 'command'}?${params}`, {
    method: action === 'state' ? 'GET' : 'POST',
    signal: AbortSignal.timeout(2400),
  });
  if (!response.ok) throw new Error(await response.text());
  const next = await response.json();
  if (order >= latestAccepted) {
    latestAccepted = order;
    state = next;
    render();
  }
  return next;
}

function showMessage(text, error = false) {
  localMessage = text;
  elements.message.classList.toggle('error', error);
  render();
}

async function startInput(kind) {
  if (busy) return;
  if (input) {
    await stopInput();
    return;
  }
  if (kind === 'board' && !('serial' in navigator)) {
    showMessage('Open localhost in desktop Chrome or Edge to use USB serial.', true);
    return;
  }
  busy = true;
  showMessage('');
  showBuzzerStatus('');
  if (!BUZZER_PATTERNS[elements['alarm-sound'].value]) void enableSpeaker().catch(() => {});
  let device;
  try {
    if (kind === 'board') {
      device = new FirmataDevice(await navigator.serial.requestPort());
      await device.open();
    }
    const initial = await request('attach', { value: kind });
    input = { kind, device, alert: initial.alert, started: performance.now() };
    elements.hardware.checked = false;
  } catch (error) {
    if (device) await device.close();
    if (error.name !== 'NotFoundError') showMessage(error.message, true);
  } finally {
    busy = false;
    render();
  }
}

async function stopInput(reason = '') {
  const current = input;
  if (!current) return;
  busy = true;
  input = null;
  cancelAlarm(current);
  render();
  try {
    if (current.device) await current.device.close();
    await request('detach');
  } catch (error) {
    reason ||= error.message;
  } finally {
    busy = false;
    elements.hardware.checked = false;
    showBuzzerStatus('');
    showMessage(reason, Boolean(reason));
  }
}

async function command(action, fields) {
  if (busy) return;
  try {
    showMessage('');
    await request(action, fields);
  } catch (error) {
    showMessage(error.message, true);
  }
}

function clockTime() {
  return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function paintDebugPin(pin, reading) {
  const led = debugLeds.get(pin);
  const indicator = led ?? elements['debug-buzzer'];
  if (!reading) {
    delete indicator.dataset.value;
    (led ? led.querySelector('strong') : indicator).textContent = '—';
    return;
  }
  const { mode, value } = reading;
  const known = mode === 1 && (value === 0 || value === 1);
  const label = known ? (value ? 'HIGH' : 'LOW') : `Mode ${mode}`;
  if (known) indicator.dataset.value = String(value);
  else delete indicator.dataset.value;
  if (led) led.querySelector('strong').textContent = label;
  else indicator.textContent = known ? `${label} · ${value ? 'On' : 'Off'}` : label;
}

function paintDebugBuzzerNote(capture) {
  elements['debug-buzzer-note'].textContent = capture.lastHigh ? `Last HIGH at ${capture.lastHigh}`
    : capture.pins.has(BUZZER_PIN) ? 'No HIGH observed since Debug mode opened.' : 'Waiting for pin readback.';
}

function showDebugPin(capture, pin, mode, value) {
  if (debugCapture !== capture || (!debugLeds.has(pin) && pin !== BUZZER_PIN)) return;
  const previous = capture.pins.get(pin);
  const next = { mode, value, seenAt: performance.now() };
  capture.pins.set(pin, next);
  if (previous?.mode !== mode || previous?.value !== value) paintDebugPin(pin, next);
  if (pin === BUZZER_PIN) {
    if (mode === 1 && value === 1) {
      if (previous?.mode !== 1 || previous?.value !== 1) capture.lastHigh = clockTime();
      if (capture.device.debugMic) capture.device.debugMic.alarm = true;
    }
    paintDebugBuzzerNote(capture);
  }
}

function showDebugMic(window) {
  const samples = window?.samples ?? 0;
  elements['debug-mic-range'].textContent = samples ? `${window.low}–${window.high} ADC` : '—';
  elements['debug-mic-span'].textContent = samples ? `${window.high - window.low} ADC` : '—';
  elements['debug-mic-count'].textContent = window ? String(samples) : '—';
  const note = elements['debug-mic-note'];
  note.textContent = !window ? 'Raw ADC readings from the last second.'
    : !samples ? 'No A0 samples received in this scan.'
      : window.alarm ? 'An alarm sounded during this scan.' : 'Raw ADC readings from the last second.';
  note.classList.toggle('during-alarm', Boolean(samples && window?.alarm));
}

function startMicWindow(capture) {
  capture.device.debugMic = {
    low: 1023, high: 0, samples: 0, alarm: alarmJob?.current?.device === capture.device,
  };
}

function requestDebugPins(capture) {
  if (capture.pending) return;
  capture.pending = true;
  capture.device.queryBuzzer(undefined, true).catch(() => { /* Stale pin readings are cleared on the next scan. */ })
    .finally(() => { capture.pending = false; });
}

function scanDebug(capture) {
  if (debugCapture !== capture) return;
  showDebugMic(capture.device.debugMic);
  startMicWindow(capture);
  elements['debug-scan'].textContent = `Last scan ${clockTime()}`;
  const now = performance.now();
  for (const [pin, reading] of capture.pins) {
    if (now - reading.seenAt <= 1600) continue;
    capture.pins.delete(pin);
    paintDebugPin(pin);
    if (pin === BUZZER_PIN) paintDebugBuzzerNote(capture);
  }
  requestDebugPins(capture);
}

function stopDebugCapture() {
  if (!debugCapture) return;
  const { device, timer } = debugCapture;
  debugCapture = null;
  clearInterval(timer);
  device.onPinState = null;
  device.debugMic = null;
  for (const pin of [...LED_PINS, BUZZER_PIN]) paintDebugPin(pin);
  elements['debug-buzzer-note'].textContent = 'Waiting for pin readback.';
  elements['debug-scan'].textContent = '1-second scans';
  showDebugMic(null);
}

function syncDebug() {
  const device = debugEnabled ? (input?.device ?? null) : null;
  if ((debugCapture?.device ?? null) !== device) {
    stopDebugCapture();
    if (device) {
      const capture = { device, pins: new Map(), lastHigh: '', pending: false };
      debugCapture = capture;
      startMicWindow(capture);
      device.onPinState = (pin, mode, value) => showDebugPin(capture, pin, mode, value);
      requestDebugPins(capture);
      capture.timer = setInterval(() => scanDebug(capture), 1000);
    }
  }
  if (debugEnabled) {
    elements['debug-source'].textContent = device ? 'Arduino pin readback · microphone scans every second'
      : input?.kind === 'demo' ? 'Demo input is simulated. Connect an Arduino for pin readback.'
        : 'Connect the Arduino to read its pins.';
  }
}

function toggleDebug() {
  debugEnabled = !debugEnabled;
  elements['debug-toggle'].setAttribute('aria-pressed', String(debugEnabled));
  elements['debug-panel'].hidden = !debugEnabled;
  syncDebug();
}

function showBuzzerStatus(message, error = false) {
  const status = elements['buzzer-status'];
  status.textContent = message;
  status.hidden = !message;
  status.classList.toggle('error', error);
}

function getSpeakerContext() {
  speakerContext ??= new AudioContext();
  return speakerContext;
}

async function enableSpeaker() {
  const context = getSpeakerContext();
  if (context.state !== 'running') await context.resume();
}

function scheduleAudio(job, node, start, duration, loudness) {
  const gain = speakerContext.createGain();
  const end = start + duration;
  const fade = Math.min(duration / 3, 0.02);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(loudness, start + fade);
  gain.gain.setValueAtTime(loudness, end - fade);
  gain.gain.linearRampToValueAtTime(0, end);
  node.connect(gain);
  gain.connect(speakerContext.destination);
  const ended = new Promise(resolve => {
    node.onended = () => {
      node.disconnect();
      gain.disconnect();
      resolve();
    };
  });
  node.start(start);
  node.stop(end);
  job.nodes.push(node);
  return ended;
}

async function playSpeaker(job, sound) {
  if (sound === 'custom' && !customSound) throw new Error('Choose an audio file first.');
  if (speakerContext?.state !== 'running') throw new Error('Click Test sound once to enable speaker audio.');
  const start = speakerContext.currentTime + 0.025;
  if (sound === 'custom') {
    const clip = speakerContext.createBufferSource();
    clip.buffer = customSound;
    await scheduleAudio(job, clip, start, Math.min(clip.buffer.duration, CUSTOM_MAX_SECONDS), 0.5);
    return;
  }
  await Promise.all(SPEAKER_TONES[sound].map(([frequency, offset, duration]) => {
    const tone = speakerContext.createOscillator();
    tone.frequency.value = frequency;
    return scheduleAudio(job, tone, start + offset, duration, 0.18);
  }));
}

function cancelAlarm(current) {
  if (!alarmJob || (current && alarmJob.current !== current)) return;
  const job = alarmJob;
  alarmJob = null;
  for (const node of job.nodes) {
    try { node.stop(); } catch { /* A completed sound has already stopped. */ }
  }
}

function alarmGuard() {
  if (elements['alarm-sound'].value !== 'custom' || !customSound) return DEFAULT_ALARM_GUARD_MS;
  const duration = Math.min(customSound.duration, CUSTOM_MAX_SECONDS);
  return Math.max(DEFAULT_ALARM_GUARD_MS, Math.ceil(duration * 1000) + 500);
}

async function soundWarning(current, test = false) {
  const sound = elements['alarm-sound'].value;
  const pattern = BUZZER_PATTERNS[sound];
  if (alarmJob || (pattern && !current?.device)) return;
  const job = { current, nodes: [] };
  alarmJob = job;
  showBuzzerStatus(test ? (pattern ? 'Testing D8…' : 'Playing test sound…') : 'Sounding the alarm…');
  render();
  try {
    if (test && !pattern) await enableSpeaker();
    if (test && current?.device) await request('test-buzzer', { value: alarmGuard() });
    if (alarmJob !== job) return;
    if (current?.device?.debugMic) current.device.debugMic.alarm = true;
    if (pattern) {
      if (await current.device.pulseBuzzer(pattern) && alarmJob === job) {
        const count = pattern.pulses.length;
        showBuzzerStatus(`D8 confirmed ${count} ${count === 1 ? 'pulse' : 'pulses'}.`);
      }
    } else {
      try {
        await playSpeaker(job, sound);
        if (alarmJob === job) showBuzzerStatus(test ? 'Test sound played.' : 'Speaker alarm played.');
      } catch (error) {
        if (test || !current?.device || alarmJob !== job) throw error;
        showBuzzerStatus(`${error.message} Using the D8 buzzer for this alarm.`, true);
        await current.device.pulseBuzzer(BUZZER_PATTERNS.double);
      }
    }
  } catch (error) {
    if (alarmJob === job) showBuzzerStatus(error.message, true);
  } finally {
    if (alarmJob === job) {
      alarmJob = null;
      render();
    }
  }
}

function restoreAlarmPreference() {
  try {
    const saved = localStorage.getItem(ALARM_PREFERENCE);
    if (Object.hasOwn(BUZZER_PATTERNS, saved) || Object.hasOwn(SPEAKER_TONES, saved)) elements['alarm-sound'].value = saved;
  } catch { /* Playback is available without browser storage. */ }
}

function selectAlarmSound() {
  const sound = elements['alarm-sound'].value;
  if (sound !== 'custom') {
    try { localStorage.setItem(ALARM_PREFERENCE, sound); } catch { /* Browser storage may be disabled. */ }
  }
  if (!BUZZER_PATTERNS[sound]) void enableSpeaker().catch(() => {});
  showBuzzerStatus('');
  render();
}

async function importAlarmSound() {
  const file = elements['alarm-file'].files[0];
  customSound = null;
  if (!file) {
    render();
    return;
  }
  importingSound = true;
  showBuzzerStatus('Reading audio file…');
  render();
  try {
    if (file.size > 12 * 1024 * 1024) throw new Error('Choose an audio file of 12 MB or smaller.');
    const bytes = await file.arrayBuffer();
    customSound = await getSpeakerContext().decodeAudioData(bytes);
    if (customSound.duration <= 0) {
      customSound = null;
      throw new Error('This audio file is empty.');
    }
    showBuzzerStatus('Audio file ready to test.');
  } catch (error) {
    elements['alarm-file'].value = '';
    showBuzzerStatus(error.name === 'EncodingError' ? 'This audio could not be read. Try an MP3 or WAV file.' : error.message, true);
  } finally {
    importingSound = false;
    render();
  }
}

function renderAlarmControls() {
  const sound = elements['alarm-sound'].value;
  const d8 = Boolean(BUZZER_PATTERNS[sound]);
  const playbackBusy = Boolean(alarmJob) || importingSound;
  elements['alarm-route'].textContent = d8 ? 'Plays on the Arduino D8 buzzer.' : 'Plays through the computer speakers.';
  elements['alarm-file-area'].hidden = sound !== 'custom';
  elements['alarm-sound'].disabled = playbackBusy;
  elements['alarm-file'].disabled = playbackBusy;
  const test = elements['test-buzzer'];
  test.textContent = d8 ? 'Test buzzer' : 'Test sound';
  test.disabled = busy || playbackBusy || Boolean(state?.active) ||
    (d8 && (!state?.ready || input?.kind !== 'board')) || (sound === 'custom' && !customSound);
}

function demoFrame(current) {
  const t = (performance.now() - current.started) / 1000;
  const phase = t % 18;
  const span = phase < 2 ? 3 : phase < 10 ? 49 + Math.round(3 * Math.sin(t * 7))
    : phase < 14 ? 15 + Math.round(8 * Math.sin(t * 5)) : 3;
  return { low: 27, high: 27 + span, selector: -1 };
}

async function refresh() {
  if (reading || busy) return;
  reading = true;
  const current = input;
  try {
    if (!current) {
      await request('state');
      return;
    }
    const frame = current.device?.frame() ?? (current.kind === 'demo' ? demoFrame(current) : null);
    const next = frame ? await request('frame', { ...frame, value: alarmGuard() }) : await request('state');
    if (input !== current) return;
    if (!next.owner) {
      await stopInput(next.notice || 'Input ownership expired. Reconnect to continue.');
      return;
    }
    if (next.alert !== current.alert) {
      current.alert = next.alert;
      void soundWarning(current);
    }
    if (current.device) await current.device.driveLeds(next.ready ? next.leds : 0);
  } catch (error) {
    if (current && input === current) await stopInput(error.message);
    else if (!state) showMessage('The local Java server is unavailable. Start it and reload this page.', true);
  } finally {
    reading = false;
  }
}

function announceStatus(text) {
  const message = elements.message;
  if (message.textContent !== text) message.textContent = text;
  message.hidden = !text;
}

function renderSensitivity() {
  elements['sensitivity-value'].value = `${Math.round((Number(elements.sensitivity.value) - 15) * 100 / 135)}%`;
}

function render() {
  announceStatus(localMessage || state?.notice || '');
  renderAlarmControls();
  syncDebug();
  elements.connect.disabled = busy || input?.kind === 'demo' || Boolean(state?.source !== 'none' && state && !input && !state.owner);
  elements.demo.disabled = busy || input?.kind === 'board' || Boolean(state?.source !== 'none' && state && !input && !state.owner);
  elements.connect.textContent = input?.kind === 'board' ? 'Disconnect Arduino' : 'Connect Arduino';
  elements.demo.textContent = input?.kind === 'demo' ? 'End demo' : 'Try demo';
  if (!state) return;
  const live = state.ready;
  const unavailable = state.source !== 'none' && !state.owner;
  elements['connection-state'].textContent = input?.kind === 'board' ? 'Arduino connected'
    : input?.kind === 'demo' ? 'Demo input' : unavailable ? 'In use in another tab' : 'Disconnected';
  elements['connection-state'].dataset.live = String(live && Boolean(input));
  elements['live-status'].textContent = live ? (state.source === 'demo' ? 'Simulated input' : 'Live A0 input')
    : state.source === 'none' ? 'Waiting for input' : 'Waiting for readings';
  elements['live-status'].dataset.live = String(live);
  elements.level.textContent = live ? state.level : '–';
  elements.adc.querySelector('strong').textContent = live ? `${state.adcSpan} ADC` : '–';
  segments.forEach((segment, index) => segment.classList.toggle('lit', live && index < state.leds));
  elements['led-bar'].setAttribute('aria-label', `${live ? state.leds : 0} of 5 LEDs lit`);
  const warning = elements['warning-status'];
  const displayedSeconds = (Math.min(49, Math.floor(state.loudMs / 100)) / 10).toFixed(1);
  warning.textContent = state.warning ? 'Warning · sustained loud level'
    : state.loudMs > 0 ? `Above limit · ${displayedSeconds} / 5 s`
      : 'Warning after 5 s above limit';
  warning.classList.toggle('hot', state.loudMs > 0 || state.warning);

  modeButtons.forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.mode === state.mode));
    button.disabled = busy || state.active || unavailable || elements.hardware.checked;
    button.querySelector('strong').textContent = state.limits[button.dataset.mode];
  });
  elements.hardware.disabled = busy || state.active || input?.kind !== 'board';
  if (elements.hardware.checked && state.selector === 3) {
    announceStatus('Both switch contacts are grounded. Check the D9 and D10 wiring.');
  }
  const slider = elements.sensitivity;
  slider.disabled = busy || state.active || unavailable;
  if (document.activeElement !== slider) {
    slider.value = String(165 - state.scale);
    renderSensitivity();
  }
  elements['session-action'].disabled = busy || !state.owner || (!state.active && !live) || !input;
  elements['session-action'].textContent = state.active ? 'Cancel session' : 'Start session';
  elements['session-note'].textContent = state.active ? `${MODES[state.mode]} · ${state.warnings} warnings · settings locked`
    : '60 seconds · one stored reading per second';
  const elapsed = state.active ? state.elapsed : (state.notice.startsWith('60-second') ? 60 : 0);
  elements['session-clock'].firstChild.textContent = elapsed === 60 ? '01:00 ' : `00:${String(elapsed).padStart(2, '0')} `;
  elements['session-progress'].value = elapsed;
  if (state.history.map(report => report.id).join(',') !== historyKey) {
    historyKey = state.history.map(report => report.id).join(',');
    records = state.history;
    fillReports();
  }
}

function option(text, value) {
  const item = document.createElement('option');
  item.value = value;
  item.textContent = text;
  return item;
}

function reportLabel(report) {
  return `Session ${report.id} · ${MODES[report.mode]}${report.source === 'demo' ? ' (demo)' : ''}`;
}

function fillReports() {
  const primary = elements['report-primary'];
  const compare = elements['report-compare'];
  const oldNewest = primary.options[0]?.value;
  const oldPrimary = primary.value;
  const oldComparison = compare.value;
  primary.replaceChildren(...records.map(report => option(reportLabel(report), report.id)));
  compare.replaceChildren(option('None', ''), ...records.map(report => option(reportLabel(report), report.id)));
  if (oldPrimary !== oldNewest && records.some(report => String(report.id) === oldPrimary)) primary.value = oldPrimary;
  if (records.some(report => String(report.id) === oldComparison)) compare.value = oldComparison;
  compare.disabled = records.length < 2;
  elements['report-empty'].hidden = records.length > 0;
  elements['report-content'].hidden = records.length === 0;
  elements.print.disabled = records.length === 0;
  const rows = records.map(report => {
    const row = document.createElement('tr');
    const started = new Date(report.started).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const cells = [`${report.id} · ${started}${report.source === 'demo' ? ' · Demo' : ''}`, MODES[report.mode], report.average.toFixed(1), report.peak, report.warnings];
    for (const value of cells) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  });
  elements.history.replaceChildren(...rows);
  renderReport();
}

function selectedReports() {
  const primary = records.find(report => report.id === Number(elements['report-primary'].value));
  const other = records.find(report => report.id === Number(elements['report-compare'].value));
  return [primary, other?.id === primary?.id ? undefined : other];
}

function renderReport() {
  const [report, other] = selectedReports();
  if (!report) return;
  const compare = elements['report-compare'];
  if (Number(compare.value) === report.id) compare.value = '';
  for (const item of compare.options) item.disabled = Number(item.value) === report.id;
  const metrics = [['Average', report.average.toFixed(1)], ['Peak', report.peak], ['Warnings', report.warnings]];
  elements['report-stats'].replaceChildren(...metrics.map(([label, value]) => {
    const item = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value;
    item.append(term, description);
    return item;
  }));
  elements.loudest.replaceChildren(...report.top.map(index => {
    const item = document.createElement('li');
    item.textContent = `Second ${index + 1} · level ${report.readings[index]}`;
    return item;
  }));
  const differentGain = other && other.scale !== report.scale;
  elements['chart-key'].textContent = `${reportLabel(report)}${other ? ` (blue) · ${reportLabel(other)} (purple)` : ''}${differentGain ? ' · different mic gain' : ''}`;
  drawChart();
}

function drawChart() {
  const [report, other] = selectedReports();
  const canvas = elements.chart;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!report || !width || !height) return;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  const start = 36;
  const top = 11;
  const bottom = height - 24;
  const end = width - 15;
  const y = value => bottom - value * (bottom - top) / 100;
  ctx.font = '12px system-ui';
  ctx.fillStyle = '#526179';
  for (const mark of [0, 25, 50, 75, 100]) {
    ctx.strokeStyle = '#e1e8f1';
    ctx.beginPath();
    ctx.moveTo(start, y(mark));
    ctx.lineTo(end, y(mark));
    ctx.stroke();
    ctx.fillText(String(mark), 6, y(mark) + 3);
  }
  ctx.fillText('1 s', start, height - 6);
  ctx.fillText('30 s', (start + end) / 2 - 13, height - 6);
  ctx.fillText('60 s', end - 24, height - 6);
  if (state) {
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#a75444';
    ctx.beginPath();
    ctx.moveTo(start, y(state.limits[report.mode]));
    ctx.lineTo(end, y(state.limits[report.mode]));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const [series, color] of [[other, '#8751ab'], [report, '#2170ac']]) {
    if (!series) continue;
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.beginPath();
    series.readings.forEach((value, index) => ctx[index ? 'lineTo' : 'moveTo'](start + index * (end - start) / 59, y(value)));
    ctx.stroke();
  }
}

elements.connect.addEventListener('click', () => startInput('board'));
elements.demo.addEventListener('click', () => startInput('demo'));
elements['debug-toggle'].addEventListener('click', toggleDebug);
elements['session-action'].addEventListener('click', () => command(state.active ? 'cancel' : 'start'));
modeButtons.forEach(button => button.addEventListener('click', () => command('mode', { value: button.dataset.mode })));
elements.sensitivity.addEventListener('input', renderSensitivity);
elements.sensitivity.addEventListener('change', () => command('scale', { value: 165 - Number(elements.sensitivity.value) }));
elements.hardware.addEventListener('change', async () => {
  if (!input?.device) return;
  try { await input.device.setSelector(elements.hardware.checked); }
  catch (error) { await stopInput(error.message); }
});
elements['report-primary'].addEventListener('change', renderReport);
elements['report-compare'].addEventListener('change', renderReport);
elements.print.addEventListener('click', () => window.print());
elements['test-buzzer'].addEventListener('click', () => soundWarning(input, true));
elements['alarm-sound'].addEventListener('change', selectAlarmSound);
elements['alarm-file'].addEventListener('change', importAlarmSound);
new ResizeObserver(drawChart).observe(elements.chart);

window.addEventListener('pagehide', () => {
  cancelAlarm();
  stopDebugCapture();
  if (!input) return;
  input.device?.stopOutputs().catch(() => {});
  const query = new URLSearchParams({ client: CLIENT, action: 'detach' });
  navigator.sendBeacon(`/api/command?${query}`);
});

restoreAlarmPreference();
renderAlarmControls();
refresh();
setInterval(refresh, 110);
