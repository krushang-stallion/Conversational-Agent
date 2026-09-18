export interface AudioRecorderCallbacks {
  onSpeechStart?: () => void;
  onSpeechResult?: (text: string, isFinal: boolean) => void;
  onAudioLevel?: (level: number) => void;
  onError?: (error: any) => void;
}

export class AudioRecorder {
  private recognition: any = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private animFrameId: number | null = null;
  private isRunning = false;
  private isMuted = false;
  private callbacks: AudioRecorderCallbacks = {};
  private finalTranscriptBuffer = '';
  private silenceTimer: any = null;

  constructor() {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (SpeechRecognition) {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = true;
      this.recognition.interimResults = true;
      this.recognition.lang = 'en-US';
    }
  }

  public setMuted(muted: boolean): void {
    this.isMuted = muted;
    if (muted) {
      this.finalTranscriptBuffer = '';
      clearTimeout(this.silenceTimer);
    }
  }

  public async start(callbacks: AudioRecorderCallbacks): Promise<void> {
    this.callbacks = callbacks;
    if (this.isRunning) return;
    this.isRunning = true;
    this.isMuted = false;
    this.finalTranscriptBuffer = '';

    // 1. Microphone & Analyser
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });

      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);

      this.trackAudioVolume();
    } catch (err) {
      console.warn('Microphone error:', err);
      if (this.callbacks.onError) this.callbacks.onError(err);
    }

    // 2. Start Speech Recognition
    if (this.recognition) {
      this.setupRecognition();
      try {
        this.recognition.start();
      } catch (e) {
        console.warn('SpeechRecognition start error:', e);
      }
    }
  }

  private setupRecognition() {
    if (!this.recognition) return;

    this.recognition.onstart = () => {
      console.log('🎤 Speech recognition listening');
    };

    this.recognition.onspeechstart = () => {
      if (!this.isMuted && this.callbacks.onSpeechStart) {
        this.callbacks.onSpeechStart();
      }
    };

    this.recognition.onresult = (event: any) => {
      if (this.isMuted) return;

      let currentInterim = '';
      let newlyFinalized = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          newlyFinalized += ' ' + transcript;
        } else {
          currentInterim += transcript;
        }
      }

      if (newlyFinalized.trim()) {
        this.finalTranscriptBuffer = (this.finalTranscriptBuffer + ' ' + newlyFinalized).trim();
      }

      const displayText = (this.finalTranscriptBuffer + ' ' + currentInterim).trim();

      if (displayText && this.callbacks.onSpeechResult) {
        // Show live interim text
        this.callbacks.onSpeechResult(displayText, false);

        // Reset silence debouncer to dispatch complete thought
        clearTimeout(this.silenceTimer);
        this.silenceTimer = setTimeout(() => {
          if (this.finalTranscriptBuffer.trim() && this.callbacks.onSpeechResult) {
            const completedPrompt = this.finalTranscriptBuffer.trim();
            this.finalTranscriptBuffer = '';
            this.callbacks.onSpeechResult(completedPrompt, true);
          }
        }, 750);
      }
    };

    this.recognition.onerror = (event: any) => {
      if (event.error !== 'no-speech') {
        console.warn('Speech recognition warning:', event.error);
      }
    };

    this.recognition.onend = () => {
      if (this.isRunning) {
        try {
          this.recognition.start();
        } catch (e) {}
      }
    };
  }

  private trackAudioVolume() {
    if (!this.analyser) return;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    const checkVolume = () => {
      if (!this.isRunning || !this.analyser) return;

      this.analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length;
      const normalizedLevel = Math.min(average / 128, 1.0);

      if (!this.isMuted && this.callbacks.onAudioLevel) {
        this.callbacks.onAudioLevel(normalizedLevel);
      }

      this.animFrameId = requestAnimationFrame(checkVolume);
    };

    this.animFrameId = requestAnimationFrame(checkVolume);
  }

  public stop(): void {
    this.isRunning = false;
    this.isMuted = false;
    clearTimeout(this.silenceTimer);
    this.finalTranscriptBuffer = '';

    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch (e) {}
    }

    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }
}
