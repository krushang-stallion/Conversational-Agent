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
  private isRecognitionActive = false;
  private callbacks: AudioRecorderCallbacks = {};
  private finalTranscriptBuffer = '';
  private currentInterimBuffer = '';
  private silenceTimer: any = null;
  private restartTimer: any = null;

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
    clearTimeout(this.silenceTimer);
    clearTimeout(this.restartTimer);
    this.finalTranscriptBuffer = '';
    this.currentInterimBuffer = '';

    if (muted) {
      // Abort recognition immediately to cleanly sever Chrome speech server connection
      // and prevent echo from computer speakers polluting the speech recognizer
      if (this.recognition && this.isRecognitionActive) {
        this.isRecognitionActive = false;
        try {
          this.recognition.abort();
        } catch (e) {
          try { this.recognition.stop(); } catch (e2) {}
        }
      }
    } else {
      // Immediately start a fresh, zero-latency speech recognition session
      if (this.isRunning && this.recognition && !this.isRecognitionActive) {
        this.safeStartRecognition();
      }
    }
  }

  public isAudioMuted(): boolean {
    return this.isMuted;
  }

  public async start(callbacks: AudioRecorderCallbacks): Promise<void> {
    this.callbacks = callbacks;
    if (this.isRunning) return;
    this.isRunning = true;
    this.isMuted = false;
    this.finalTranscriptBuffer = '';
    this.currentInterimBuffer = '';

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
      this.safeStartRecognition();
    }
  }

  private safeStartRecognition() {
    if (!this.recognition || !this.isRunning || this.isMuted || this.isRecognitionActive) return;
    try {
      this.recognition.start();
      this.isRecognitionActive = true;
    } catch (e: any) {
      if (e?.name === 'InvalidStateError') {
        // Recognition is still transitioning/shutting down. Retry in 60ms.
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          if (this.isRunning && !this.isMuted && !this.isRecognitionActive) {
            this.safeStartRecognition();
          }
        }, 60);
      }
    }
  }

  private setupRecognition() {
    if (!this.recognition) return;

    this.recognition.onstart = () => {
      this.isRecognitionActive = true;
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
      this.currentInterimBuffer = currentInterim.trim();

      const displayText = (this.finalTranscriptBuffer + ' ' + this.currentInterimBuffer).trim();

      if (displayText && this.callbacks.onSpeechResult) {
        // Show live interim text in subtitle box
        this.callbacks.onSpeechResult(displayText, false);

        // Reset silence debouncer to dispatch complete thought
        clearTimeout(this.silenceTimer);
        const textToDispatch = displayText;
        // If Chrome has stabilized at least one final segment, 1000ms silence confirms completion.
        // If still pure interim, wait 1500ms to prevent premature partial dispatch (e.g. iodine vs IOD).
        const debounceMs = this.finalTranscriptBuffer.trim().length > 0 ? 1000 : 1500;

        this.silenceTimer = setTimeout(() => {
          if (textToDispatch && this.callbacks.onSpeechResult && !this.isMuted) {
            this.finalTranscriptBuffer = '';
            this.currentInterimBuffer = '';
            // Immediately lock/mute microphone on dispatch so subsequent corrections or room sounds cannot trigger duplicate turns
            this.setMuted(true);
            this.callbacks.onSpeechResult(textToDispatch, true);
          }
        }, debounceMs);
      }
    };

    this.recognition.onerror = (event: any) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        console.warn('Speech recognition warning:', event.error);
      }
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        this.isRunning = false;
        this.isRecognitionActive = false;
      }
    };

    this.recognition.onend = () => {
      this.isRecognitionActive = false;
      clearTimeout(this.restartTimer);
      // Immediately restart if active and not muted
      if (this.isRunning && !this.isMuted) {
        this.restartTimer = setTimeout(() => {
          if (this.isRunning && !this.isMuted && !this.isRecognitionActive) {
            this.safeStartRecognition();
          }
        }, 50);
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
      } else if (this.isMuted && this.callbacks.onAudioLevel) {
        this.callbacks.onAudioLevel(0);
      }

      this.animFrameId = requestAnimationFrame(checkVolume);
    };

    this.animFrameId = requestAnimationFrame(checkVolume);
  }

  public stop(): void {
    this.isRunning = false;
    this.isMuted = false;
    this.isRecognitionActive = false;
    clearTimeout(this.silenceTimer);
    clearTimeout(this.restartTimer);
    this.finalTranscriptBuffer = '';
    this.currentInterimBuffer = '';

    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch (e) {
        try { this.recognition.stop(); } catch (e2) {}
      }
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

