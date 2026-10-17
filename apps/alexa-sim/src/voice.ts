// Voice in/out with the Web Speech API (Chrome/Edge). Polly / Nova Sonic replace this in AWS.
type Rec = { start(): void; stop(): void; onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: ((e: any) => void) | null; lang: string; interimResults: boolean; continuous: boolean };

export function speechSupported() {
  return typeof window !== "undefined" && ("webkitSpeechRecognition" in window || "SpeechRecognition" in window);
}

export function listenOnce(onText: (t: string) => void, onEnd: () => void): () => void {
  const Ctor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
  if (!Ctor) {
    onEnd();
    return () => {};
  }
  const rec: Rec = new Ctor();
  rec.lang = "en-US";
  rec.interimResults = false;
  rec.continuous = false;
  rec.onresult = (e) => {
    const t = e.results?.[0]?.[0]?.transcript;
    if (t) onText(String(t));
  };
  rec.onerror = () => onEnd();
  rec.onend = () => onEnd();
  rec.start();
  return () => rec.stop();
}

let voice: SpeechSynthesisVoice | undefined;
function pickVoice() {
  const vs = speechSynthesis.getVoices();
  voice = vs.find((v) => /en-US/i.test(v.lang) && /(Aria|Jenny|Samantha|Google US English|Female)/i.test(v.name)) ?? vs.find((v) => /en-US/i.test(v.lang)) ?? vs[0];
}
if (typeof speechSynthesis !== "undefined") {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

export function speak(text: string, onDone?: () => void) {
  if (typeof speechSynthesis === "undefined" || !text) {
    onDone?.();
    return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.rate = 1.04;
  u.onend = () => onDone?.();
  u.onerror = () => onDone?.();
  speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (typeof speechSynthesis !== "undefined") speechSynthesis.cancel();
}
