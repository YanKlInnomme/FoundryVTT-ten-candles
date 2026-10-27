import { SYSTEM_ID } from "../constants.mjs";
import { AuthorityService } from "./authority-service.mjs";

const CHANNEL = `system.${SYSTEM_ID}`;
const CHUNK_BYTES = 256 * 1024;
const UPLOAD_TIMEOUT_MS = 60_000;

/**
 * Browser-local recording drafts and world-file storage. MediaStreams, Blobs and
 * object URLs stay here; the session Actor stores only submitted paths/metadata.
 * Players without FILES_UPLOAD send bounded chunks to the elected GM, which
 * checks the recording turn and validates the reconstructed file before upload.
 */
export class RecordingService {
  static #sessions = new Map();
  static #pendingUploads = new Map();
  static #incomingUploads = new Map();
  static #initialized = false;
  static #storageWorldId = null;

  static initialize() {
    if (this.#initialized) return;
    game.socket.on(CHANNEL, (message, senderUserId) => { void this.#onSocketMessage(message, senderUserId); });
    this.#initialized = true;
  }

  static getState(ritualId) {
    const session = this.#sessions.get(ritualId);
    return session ? {
      recording: session.recorder?.state === "recording",
      ready: Boolean(session.blob),
      previewUrl: session.previewUrl,
      durationMs: session.durationMs,
      elapsedMs: session.recorder?.state === "recording" ? Date.now() - session.startedAt : 0
    } : { recording: false, ready: false, previewUrl: null, durationMs: null, elapsedMs: null };
  }

  static getVisualizationSource(ritualId) {
    const session = this.#sessions.get(ritualId);
    return session ? { stream: session.stream, blob: session.blob, waveform: session.waveform ?? [] } : { stream: null, blob: null, waveform: [] };
  }

  static appendWaveformSample(ritualId, amplitude) {
    const session = this.#sessions.get(ritualId);
    if (!session || session.recorder?.state !== "recording") return;
    const now = performance.now();
    if (now - (session.lastWaveformSampleAt ?? 0) < 45) return;
    session.lastWaveformSampleAt = now;
    session.waveform.push(Math.max(0, Math.min(1, Number(amplitude) || 0)));
  }

  static async start(ritualId) {
    this.discard(ritualId);
    if (typeof MediaRecorder === "undefined") throw new Error("Audio recording is not supported by this browser. Upload an audio file instead.");
    const stream = await this.#getLocalAudioStream();
    const mimeType = this.#supportedMimeType();
    const chunks = [];
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const session = { recorder, stream, chunks, startedAt: Date.now(), blob: null, previewUrl: null, durationMs: null, source: "microphone", waveform: [], lastWaveformSampleAt: 0 };
    recorder.addEventListener("dataavailable", (event) => { if (event.data.size) chunks.push(event.data); });
    this.#sessions.set(ritualId, session);
    recorder.start();
  }

  static async stop(ritualId) {
    const session = this.#sessions.get(ritualId);
    if (!session || session.recorder.state !== "recording") throw new Error("No recording is currently in progress.");
    await new Promise((resolve) => {
      session.recorder.addEventListener("stop", resolve, { once: true });
      session.recorder.stop();
    });
    session.stream.getTracks().forEach((track) => track.stop());
    session.durationMs = Date.now() - session.startedAt;
    session.blob = new Blob(session.chunks, { type: session.recorder.mimeType || "audio/webm" });
    session.previewUrl = URL.createObjectURL(session.blob);
    return this.getState(ritualId);
  }

  static async useFile(ritualId, file) {
    const durationMs = await this.validateAudioFile(file);
    this.discard(ritualId);
    const previewUrl = URL.createObjectURL(file);
    this.#sessions.set(ritualId, { recorder: null, stream: null, chunks: [], startedAt: null, blob: file, previewUrl, durationMs, source: "upload", waveform: [] });
    return this.getState(ritualId);
  }

  static async validateAudioFile(file) {
    if (!(file instanceof File) || file.size <= 0 || file.size > 50 * 1024 * 1024) throw new Error(game.i18n.localize("TENCANDLES.Recording.InvalidAudio"));
    const extension = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
    const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
    const signatures = {
      webm: bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3,
      ogg: ascii(0, 4) === "OggS",
      wav: ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE",
      flac: ascii(0, 4) === "fLaC",
      mp3: ascii(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0),
      mp4: ascii(4, 8) === "ftyp",
      aiff: ascii(0, 4) === "FORM" && ["AIFF", "AIFC"].includes(ascii(8, 12)),
      au: bytes[0] === 0x2e && bytes[1] === 0x73 && bytes[2] === 0x6e && bytes[3] === 0x64
    };
    const format = ["webm", "weba", "mka"].includes(extension) ? "webm"
      : ["ogg", "oga", "opus"].includes(extension) ? "ogg"
      : extension === "wav" ? "wav" : extension === "flac" ? "flac"
      : extension === "mp3" ? "mp3" : extension === "m4a" ? "mp4"
      : ["aif", "aiff"].includes(extension) ? "aiff" : extension === "au" ? "au" : null;
    if (!format || !signatures[format]) throw new Error(game.i18n.localize("TENCANDLES.Recording.InvalidAudio"));
    return this.#probeAudioDuration(file);
  }

  static #probeAudioDuration(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const audio = new Audio();
      let settled = false;
      const finish = (duration = null) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        audio.removeAttribute("src");
        audio.load();
        URL.revokeObjectURL(url);
        if (Number.isFinite(duration) && duration > 0) resolve(Math.round(duration * 1000));
        else reject(new Error(game.i18n.localize("TENCANDLES.Recording.InvalidAudio")));
      };
      const timeout = window.setTimeout(() => finish(), 10_000);
      audio.preload = "metadata";
      audio.addEventListener("loadedmetadata", async () => {
        if (Number.isFinite(audio.duration) && audio.duration > 0) return finish(audio.duration);
        // MediaRecorder WebM files may omit duration metadata. Decode the
        // actual samples instead of rejecting a playable recording as invalid.
        let context;
        try {
          context = new AudioContext();
          const decoded = await context.decodeAudioData(await file.arrayBuffer());
          finish(decoded.duration);
        } catch (_error) {
          finish();
        } finally {
          if (context) void context.close().catch(() => {});
        }
      }, { once: true });
      audio.addEventListener("error", () => finish(), { once: true });
      audio.src = url;
    });
  }

  static async upload(ritualId, userId) {
    const session = this.#sessions.get(ritualId);
    if (!session?.blob) throw new Error("Record or choose an audio file before confirming.");
    const extension = this.#extensionFor(session.blob.type, session.blob.name);
    const fileName = `${game.world.id}-${ritualId}-${userId}-${Date.now()}.${extension}`;
    const file = session.blob instanceof File
      ? new File([session.blob], fileName, { type: session.blob.type })
      : new File([session.blob], fileName, { type: session.blob.type || "audio/webm" });
    const mediaPath = game.user.isGM || game.user.can("FILES_UPLOAD")
      ? await this.#uploadToWorld(file)
      : await this.#requestAuthorityUpload(ritualId, file);
    if (!mediaPath) throw new Error("Foundry did not return the uploaded audio path.");
    return { mediaPath, durationMs: session.durationMs, source: session.source };
  }

  static discard(ritualId) {
    // Object URLs and microphone tracks are resources, not ordinary data.
    // Release them when replacing a draft, while leaving uploaded files intact.
    const session = this.#sessions.get(ritualId);
    if (!session) return;
    if (session.recorder?.state === "recording") session.recorder.stop();
    session.stream?.getTracks().forEach((track) => track.stop());
    if (session.previewUrl) URL.revokeObjectURL(session.previewUrl);
    this.#sessions.delete(ritualId);
  }

  static async #getLocalAudioStream() {
    // Reuse Foundry's active AV input (including compatible AV modules). Clone
    // its tracks so stopping this recorder cannot mute the ongoing voice call.
    const foundryStream = game.webrtc?.client?.getMediaStreamForUser?.(game.user.id);
    const tracks = foundryStream?.getAudioTracks?.() ?? [];
    if (tracks.length) return new MediaStream(tracks.map((track) => track.clone()));
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Audio recording is not supported by this browser.");
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }

  static #supportedMimeType() {
    return ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]
      .find((type) => MediaRecorder.isTypeSupported(type)) ?? "";
  }

  static #extensionFor(mimeType = "", name = "") {
    const named = name.split(".").pop()?.toLowerCase();
    if (named && named !== name.toLowerCase()) return named;
    if (mimeType.includes("ogg")) return "ogg";
    if (mimeType.includes("mp4")) return "m4a";
    return "webm";
  }

  static async #uploadToWorld(file) {
    // Store under the world, never the installed system: updating/replacing the
    // system package must not remove a game's recordings.
    const FilePicker = foundry.applications.apps.FilePicker.implementation;
    const target = await this.#ensureWorldStorage(FilePicker);
    const response = await FilePicker.upload("data", target, file, {}, { notify: false });
    if (game.settings.get(SYSTEM_ID, "debugMode")) {
      console.info("Ten Candles | World recording upload response", { target, response });
    }
    if (response === false) throw new Error("Foundry could not upload the recording to the current world.");
    if (response?.error) throw new Error(response.error.message ?? response.error);
    const candidates = [
      response,
      response?.path,
      response?.url,
      response?.file,
      response?.files?.[0],
      response?.data?.path,
      response?.data?.url,
      response?.result?.path,
      response?.result?.url
    ];
    const returnedPath = candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0);
    if (returnedPath) return returnedPath;
    const worldPath = `${target}/${encodeURIComponent(file.name)}`;
    console.info("Ten Candles | Foundry returned no upload path; using the canonical world path", { worldPath, response });
    return worldPath;
  }

  static async #ensureWorldStorage(FilePicker) {
    const worldId = game.world.id;
    const target = `worlds/${worldId}/ten-candles-recordings`;
    if (this.#storageWorldId === worldId) return target;
    try {
      const contents = await FilePicker.browse("data", target);
      if (contents !== false) {
        this.#storageWorldId = worldId;
        return target;
      }
    } catch (_error) {
      // The recording directory does not exist yet for this world.
    }
    try {
      const created = await FilePicker.createDirectory("data", target, { notify: false });
      if (created === false) throw new Error("Foundry refused to create the world recording directory.");
    } catch (error) {
      // Another active GM may have created it between browse and create.
      try {
        const contents = await FilePicker.browse("data", target);
        if (contents === false) throw error;
      } catch (_browseError) {
        throw new Error(`Unable to prepare this world's Ten Candles recording directory: ${error.message}`);
      }
    }
    this.#storageWorldId = worldId;
    return target;
  }

  static async #requestAuthorityUpload(ritualId, file) {
    // Small socket frames avoid sending a whole recording as one payload. The
    // upload acknowledgement is separate from recording.submit: only submit a
    // persistent mediaPath once storage has actually succeeded.
    const authority = AuthorityService.user;
    if (!authority) throw new Error("No active GM is available to store this recording.");
    const uploadId = foundry.utils.randomID();
    const buffer = await file.arrayBuffer();
    const total = Math.ceil(buffer.byteLength / CHUNK_BYTES);
    const promise = new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.#pendingUploads.delete(uploadId);
        reject(new Error("The recording upload timed out."));
      }, UPLOAD_TIMEOUT_MS);
      this.#pendingUploads.set(uploadId, { resolve, reject, timeout, authorityUserId: authority.id });
    });
    for (let index = 0; index < total; index += 1) {
      const start = index * CHUNK_BYTES;
      game.socket.emit(CHANNEL, {
        type: "recording.upload.chunk",
        authorityUserId: authority.id,
        senderUserId: game.user.id,
        ritualId,
        uploadId,
        index,
        total,
        fileName: file.name,
        mimeType: file.type,
        data: buffer.slice(start, Math.min(buffer.byteLength, start + CHUNK_BYTES))
      });
    }
    return promise;
  }

  static async #onSocketMessage(message, senderUserId) {
    if (message?.type === "recording.upload.result") {
      const pending = this.#pendingUploads.get(message.uploadId);
      if (senderUserId !== pending?.authorityUserId || message.targetUserId !== game.user.id) return;
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      this.#pendingUploads.delete(message.uploadId);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.mediaPath);
      return;
    }
    if (message?.type !== "recording.upload.chunk" || !AuthorityService.isCurrentUser || message.authorityUserId !== game.user.id) return;
    if (message.senderUserId !== senderUserId) return;
    const validChunk = Number.isInteger(message.total) && message.total > 0 && message.total <= 200
      && Number.isInteger(message.index) && message.index >= 0 && message.index < message.total
      && message.data instanceof ArrayBuffer && message.data.byteLength > 0 && message.data.byteLength <= CHUNK_BYTES;
    if (!validChunk) return;
    const ritual = game.actors.get(message.ritualId);
    const requestedRetake = ritual?.system.recording.entries.find((entry) => entry.userId === message.senderUserId && entry.status === "retake");
    const current = requestedRetake ?? ritual?.system.recording.entries.find((entry) => entry.status === "pending");
    if (ritual?.system.phase !== "recording" || current?.userId !== message.senderUserId) return;
    const incoming = this.#incomingUploads.get(message.uploadId) ?? {
      senderUserId: message.senderUserId,
      fileName: message.fileName,
      mimeType: message.mimeType,
      total: message.total,
      chunks: new Array(message.total),
      received: new Set(),
      timeout: window.setTimeout(() => this.#incomingUploads.delete(message.uploadId), UPLOAD_TIMEOUT_MS)
    };
    incoming.chunks[message.index] = message.data;
    incoming.received.add(message.index);
    this.#incomingUploads.set(message.uploadId, incoming);
    if (incoming.received.size !== incoming.total) return;
    window.clearTimeout(incoming.timeout);
    this.#incomingUploads.delete(message.uploadId);
    try {
      const file = new File(incoming.chunks, incoming.fileName, { type: incoming.mimeType });
      await this.validateAudioFile(file);
      const mediaPath = await this.#uploadToWorld(file);
      game.socket.emit(CHANNEL, { type: "recording.upload.result", uploadId: message.uploadId, targetUserId: incoming.senderUserId, mediaPath });
    } catch (error) {
      game.socket.emit(CHANNEL, { type: "recording.upload.result", uploadId: message.uploadId, targetUserId: incoming.senderUserId, error: error.message });
    }
  }
}
