# Model Loading

Web Bro loads and runs the Gemma 4 E2B-it ONNX model entirely in the browser using transformer.js and WebGPU.

## Implementation Details

### Model Source
- Model: `onnx-community/gemma-4-E2B-it-ONNX` (q4f16 quantization)
- ~2.3B effective parameters, ~3 GB download (text-only, vision/audio encoders excluded via `Gemma4ForCausalLM`)
- Source: Hugging Face model hub
- Initial download occurs on first use
- Subsequent uses load from browser cache or local folder cache

### Runtime Environment
- transformer.js (`@huggingface/transformers` 4.0.1) for ONNX model execution
- WebGPU backend for hardware acceleration
- Runs in a dedicated Web Worker (`llm.worker.ts`) to avoid blocking the main thread
- Uses `AutoProcessor` for chat template rendering and `Gemma4ForCausalLM` for text-only inference

### Loading Process
1. Check for cached model in local folder or IndexedDB
2. If not found, download from Hugging Face
3. Initialize transformer.js with WebGPU provider
4. Prepare processor and model assets; tool definitions are injected via `apply_chat_template({ tools })`
5. Model ready for inference requests

### Memory Management
- Model weights loaded into GPU memory through WebGPU
- Automatic cleanup when worker terminates
- Manual cleanup available via store actions
- Memory usage monitored to prevent OOM conditions

## Performance Characteristics
- First load: Download time + initialization depending on connection and GPU
- Subsequent loads: Near-instant from cache
- Inference speed: Depends on GPU capabilities
- Token generation: Streaming output for responsive UI
