# Auto-AVSR attribution

`vendor/auto_avsr` contains unmodified inference source and the mouth alignment
reference from [mpc001/auto_avsr](https://github.com/mpc001/auto_avsr), revision
`182b62837773ab01052d4ac21ef1d2203ea7d267`. Copyright notices and the Apache 2.0
license are retained. Only the token list, ESPnet inference modules, and mouth
crop implementation/reference are included; no training corpus is redistributed.

Ma, Pingchuan et al., *Auto-AVSR: Audio-Visual Speech Recognition with Automatic
Labels*, ICASSP 2023. See the upstream repository for paper and model details.

The checkpoint is downloaded separately from the upstream model zoo and is not
committed or served publicly. Code licensing does not by itself establish
commercial rights to pretrained weights or their training datasets. This is a
research deployment; review upstream model/dataset terms before commercial use.

Checkpoint: `vsr_trlrs2lrs3vox2avsp_base.pth` (3291 training hours).
SHA-256: `fbf7cd70ff1c0e694b3030fb779dbb4570f04e4b841d62f9296c229e94878ddb`.
Upstream reports 20.3% WER on LRS3. This does not measure SilentLink, its beam-3
CPU configuration, silently mouthed speech, or any individual user.

SilentLink's personal vocabulary baseline uses normalized mean and standard
deviation of frozen frontend features, cosine nearest examples, and conservative
experimental rejection thresholds. It is not a validated model or fine-tuning.

## Browser face mesh

The 3D motion lab uses Google's `@mediapipe/tasks-vision` 1.2.3 (Apache 2.0)
and the official Face Landmarker float16 model, downloaded separately during
the dashboard build. Assets and model run locally in the browser and are served
from the same origin. MediaPipe's bundled copyright notices are preserved.
See the [MediaPipe source and license](https://github.com/google-ai-edge/mediapipe)
and [Face Landmarker documentation](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker).
Model SHA-256: `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`.

[SilentSpeak](https://github.com/shashank11yadav/SilentSpeak) was reviewed as a
reference for landmark-based recognition and pose-normalized features. Its ONNX
word model and dataset are not included. SilentLink's motion-only baseline uses
temporal distance matching of confirmed phrase examples, not a pretrained
English sentence model. See `docs/MESH.md` for limitations and retention.
