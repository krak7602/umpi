# Smart Turn

Voice mode hears whether the owner sounds finished with [Smart Turn v3.2](https://github.com/pipecat-ai/smart-turn)
by Daily (BSD-2-Clause, `SmartTurn-LICENSE.txt` in this folder, also shipped in the app), a Whisper Tiny encoder with a classifier, from
[pipecat-ai/smart-turn-v3](https://huggingface.co/pipecat-ai/smart-turn-v3).

- `SmartTurn.mlpackage` is `smart-turn-v3.2-gpu.onnx` converted to Core ML (onnx2torch, then coremltools 9): weights
  stored as 8-bit integers, computed in 32-bit floats. Half-precision computation is not used: it gave a probability
  0.69 away from the original on real speech features. The 8-bit model stays within 0.03 of the original.
- `SmartTurnMel.bin` is Whisper's 80-band mel filter bank for 16 kHz (`WhisperFeatureExtractor.mel_filters`, 201 × 80
  little-endian float32, frequency-major), used to make the model's input on the device.

The input is the last 8 s of the turn at 16 kHz, zero-padded at the start, normalized to zero mean and unit variance,
as Whisper log-mel features (`SmartTurn.features`). The output is the probability that the turn is complete.
