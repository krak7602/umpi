# FluidAudio and Kokoro

Voice mode's natural voice uses [FluidAudio](https://github.com/FluidInference/FluidAudio) (Apache-2.0, license in
this folder), added as a Swift package, to run [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (Apache-2.0)
on the phone. The Core ML model files are downloaded on first use from
[FluidInference/kokoro-82m-coreml](https://huggingface.co/FluidInference/kokoro-82m-coreml); they are not part of this
repository or the app bundle.
