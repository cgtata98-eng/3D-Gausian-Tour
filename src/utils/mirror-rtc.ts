/**
 * WebRTC-based viewer mirroring across browser tabs.
 *
 * The sender captures its canvas as a MediaStream (`canvas.captureStream(30)`)
 * and pipes it to one or more receivers via WebRTC peer connections. Signalling
 * (offer / answer / ICE) goes over `BroadcastChannel` so we don't need a server
 * — works as long as both tabs are in the same browser on the same machine.
 *
 * Usage:
 *   const s = new MirrorSender();  s.start(canvas);   // sender tab
 *   const r = new MirrorReceiver(); r.start(stream => video.srcObject = stream);
 *
 * Cross-machine mirroring would need a real signalling server (Cloudflare Worker
 * with Durable Objects, etc.) — slot the same `MirrorSender` / `MirrorReceiver`
 * over a different transport in that case.
 */
const CHANNEL = '3droomtour-mirror-rtc';

type SignalMsg =
  | { type: 'request-offer' }
  | { type: 'offer'; payload: RTCSessionDescriptionInit }
  | { type: 'answer'; payload: RTCSessionDescriptionInit }
  | { type: 'ice-sender'; payload: RTCIceCandidateInit }
  | { type: 'ice-receiver'; payload: RTCIceCandidateInit };

export class MirrorSender {
  private pc: RTCPeerConnection | null = null;
  private channel: BroadcastChannel | null = null;
  private stream: MediaStream | null = null;

  /** Begin advertising. The receiver triggers the actual handshake by sending
   *  `request-offer` when it joins. */
  start(canvas: HTMLCanvasElement) {
    // 30 fps is plenty for a viewer mirror; canvas.captureStream defaults match
    // canvas refresh rate which is fine for our use case.
    this.stream = (canvas as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream })
      .captureStream(30);
    this.channel = new BroadcastChannel(CHANNEL);
    this.channel.addEventListener('message', this.onSignal);
    // Tell any receiver already waiting that we're online.
    this.channel.postMessage({ type: 'sender-online' });
  }

  private onSignal = async (ev: MessageEvent) => {
    const msg = ev.data as SignalMsg & { type?: string };
    if (!msg?.type) return;

    if (msg.type === 'request-offer') {
      // Tear down any previous PC so reconnects work cleanly.
      this.pc?.close();
      this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      this.stream?.getTracks().forEach((t) => this.pc!.addTrack(t, this.stream!));
      this.pc.onicecandidate = (e) => {
        if (e.candidate) this.channel?.postMessage({ type: 'ice-sender', payload: e.candidate.toJSON() });
      };
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.channel?.postMessage({ type: 'offer', payload: offer });
      return;
    }
    if (msg.type === 'answer' && this.pc) {
      await this.pc.setRemoteDescription(msg.payload);
      return;
    }
    if (msg.type === 'ice-receiver' && this.pc) {
      try { await this.pc.addIceCandidate(msg.payload); } catch { /* ignore late ICE */ }
      return;
    }
  };

  stop() {
    this.channel?.removeEventListener('message', this.onSignal);
    this.channel?.close();
    this.channel = null;
    this.pc?.close();
    this.pc = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

export class MirrorReceiver {
  private pc: RTCPeerConnection | null = null;
  private channel: BroadcastChannel | null = null;
  private onStream: ((s: MediaStream) => void) | null = null;

  start(onStream: (s: MediaStream) => void) {
    this.onStream = onStream;
    this.channel = new BroadcastChannel(CHANNEL);
    this.channel.addEventListener('message', this.onSignal);
    // Ping any sender that's already running. If the sender comes online later
    // it will broadcast `sender-online`, and we'll request again from there.
    this.channel.postMessage({ type: 'request-offer' });
  }

  private onSignal = async (ev: MessageEvent) => {
    const msg = ev.data as SignalMsg & { type?: string };
    if (!msg?.type) return;

    if (msg.type === 'offer') {
      this.pc?.close();
      this.pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      this.pc.ontrack = (e) => {
        const s = e.streams[0];
        if (s) this.onStream?.(s);
      };
      this.pc.onicecandidate = (e) => {
        if (e.candidate) this.channel?.postMessage({ type: 'ice-receiver', payload: e.candidate.toJSON() });
      };
      await this.pc.setRemoteDescription(msg.payload);
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      this.channel?.postMessage({ type: 'answer', payload: answer });
      return;
    }
    if (msg.type === 'ice-sender' && this.pc) {
      try { await this.pc.addIceCandidate(msg.payload); } catch { /* ignore */ }
      return;
    }
    // A new sender announced itself after we joined — re-request the offer.
    if ((msg as { type: string }).type === 'sender-online') {
      this.channel?.postMessage({ type: 'request-offer' });
    }
  };

  stop() {
    this.channel?.removeEventListener('message', this.onSignal);
    this.channel?.close();
    this.channel = null;
    this.pc?.close();
    this.pc = null;
  }
}
