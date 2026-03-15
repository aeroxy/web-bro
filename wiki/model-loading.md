# Model Loading

Web Bro loads and runs the Qwen 3.5 2B ONNX model entirely in the browser using transformer.js and WebGPU.

## Implementation Details

### Model Source
- Model: Qwen 3.5 2B ONNX format
- Source: Hugging Face model hub
- Initial download occurs on first use
- Subsequent uses load from browser cache (IndexedDB)

### Runtime Environment
- transformer.js library for ONNX model execution
- WebGPU backend for hardware acceleration
- Runs in a dedicated Web Worker (`llm.worker.ts`) to avoid blocking the main thread

### Loading Process
1. Check for cached model in IndexedDB
2. If not found, download from Hugging Face
3. Initialize transformer.js with WebGPU provider
4. Warm up the model with a dummy inference
5. Model ready for inference requests

### Memory Management
- Model weights (~4GB) loaded into GPU memory
- Automatic cleanup when worker terminates
- Manual cleanup available via store actions
- Memory usage monitored to prevent OOM conditions

## Performance Characteristics
- First load: Download time + initialization (~10-30 seconds depending on connection)
- Subsequent loads: Near-instant from cache
- Inference speed: Depends on GPU capabilities
- Token generation: Streaming output for responsive UI