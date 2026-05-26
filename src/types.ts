export interface Audiobook {
  id: string; // unique identifier
  title: string;
  authors: string[];
  source: 'librivox' | 'internetarchive';
  sourceId: string;
  language: string;
  durationSeconds?: number;
  numTracks?: number;
  downloadUrl: string; //ZIP or direct list url
  tracks?: Track[];
  licenseText?: string;
  licenseUrl?: string;
  description?: string;
  verification?: VerificationResult;
}

export interface Track {
  title: string;
  url: string;
  play_order?: number;
}

export interface VerificationResult {
  status: 'pending' | 'verifying' | 'verified' | 'failed';
  metadataOk: boolean;
  audioOk: boolean;
  detectedLanguage?: string;
  confidence?: number;
  transcriptionSample?: string;
  analysis?: string;
  verifiedAt?: string;
  sampleUrlUsed?: string;
}

export interface JobState {
  jobId: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  progress: number;
  message: string;
  result?: VerificationResult;
}
