# Local LLM Selection & Optimization Guide
*A Definitive Hardware Tier and Deployment Resource for llama.cpp (GGUF)*

---

## 1. VRAM Allocation & Overhead Principles
When hosting Large Language Models (LLMs) locally using `llama.cpp`, precise allocation of unified memory or VRAM is essential to prevent falling back to slow system RAM (swap). The VRAM requirement is not merely the static file size of the GGUF model; it is composed of three elements:

$$VRAM_{\text{Total}} = VRAM_{\text{Model}} + VRAM_{\text{KV Cache}} + VRAM_{\text{System Overhead}}$$

*   **VRAM Model:** The static size of the weights determined by parameter count and quantization precision (e.g., `Q4_K_M`, `Q8_0`).
*   **VRAM KV Cache:** The active memory buffer holding the context (history) of your session. At 32K context with Flash Attention, this typically requires 1.0–2.5 GB.
*   **VRAM System Overhead:** OS requirements, browser processes, and graphic displays (usually consuming 1.5–2.0 GB)[cite: 1, 2].

---

## 2. Comprehensive Memory Tier Breakdown

### 8GB VRAM / RAM Tier
*   **Target GGUF Size:** 4.5 GB - 5.5 GB[cite: 1, 2]
*   **Qwen3-8B-Instruct (Best All-Rounder):** Runs optimally at `Q4_K_M` or `Q5_K_M`[cite: 1, 2]. This model represents the state-of-the-art for conversational versatility, instruction-following, and light writing tasks within a compact memory profile[cite: 1, 2].
*   **DeepSeek-R1-Distill-Qwen-8B (Best for Logic & Reasoning):** Runs beautifully at `Q4_K_M`[cite: 1, 2]. Leveraging chain-of-thought processing distilled from R1, it is ideal for complex logic, multi-step planning, and systematic math resolution[cite: 1, 2].
*   **Phi-4-mini (3.8B) (Ultra-Lightweight):** Deployable at `Q8_0` or Native `FP16`[cite: 1, 2]. Microsoft’s highly optimized model fits entirely in cache, allowing massive context headroom and blazing token generation speeds[cite: 1, 2].

### 16GB VRAM / RAM Tier
*   **Target GGUF Size:** 10.0 GB - 12.0 GB[cite: 1, 2]
*   **gpt-oss-20b (Best All-Rounder):** Recommended at `Q4_K_M`[cite: 1, 2]. Extremely stable, open-source weight framework supporting up to a 128k context buffer[cite: 1, 2]. Handles diverse context windows cleanly[cite: 1, 2].
*   **Qwen3.5-9B-MTP (Best for Code & Agents):** Deploy at `Q8_0`[cite: 1, 2]. Incorporates Multi-Token Prediction (MTP), delivering rapid generation and deep structured outputs while maintaining low overall memory usage[cite: 1, 2].
*   **Qwen3-14B-Instruct (Alternative Generalist):** Deploy at `Q5_K_M` or `Q6_K`[cite: 1, 2]. Strikes an exceptional balance of writing eloquence, intermediate programming capacity, and analytical depth[cite: 1, 2].

### 24GB VRAM / RAM Tier
*   **Target GGUF Size:** 15.0 GB - 18.0 GB[cite: 1, 2]
*   **Qwen3-32B-Instruct (Best All-Rounder):** Recommended at `Q4_K_M`[cite: 1, 2]. The gold standard for consumer GPU architectures, delivering performance comparable to closed proprietary models on general assistant tasks[cite: 1, 2].
*   **Gemma 3 27B (Best Multimodal / Vision):** Deploy at `Q4_K_M`[cite: 1, 2]. Google's Quantization-Aware Trained (QAT) model which performs close to native precision even at 4-bit, making it excellent for visual document analysis[cite: 1, 2].
*   **DeepSeek-R1-Distill-Qwen-32B (Best for Reasoning):** Deploy at `Q4_K_M`[cite: 1, 2]. A reasoning powerhouse running locally[cite: 1, 2]. Perfect for heavy coding, architectural software planning, and deep mathematical synthesis[cite: 1, 2].

### 32GB VRAM / RAM Tier
*   **Target GGUF Size:** 22.0 GB - 26.0 GB[cite: 1, 2]
*   **Qwen2.5-Coder-32B / Qwen3-32B-Instruct (Best Higher-Precision):** Deploy at `Q5_K_M` or `Q6_K`[cite: 1, 2]. This physical hardware limit allows running highly capable 32B models at denser quantizations, reclaiming lost intelligence from lower 4-bit compressions[cite: 1, 2].
*   **Qwen3.6-35B-A3B (Best MoE Speed & Logic):** Deploy at `Q5_K_M`[cite: 1, 2]. A Mixture-of-Experts (MoE) configuration[cite: 1, 2]. Activating only 3.5B active parameters per token, it yields high-speed token generation alongside a massive knowledge base[cite: 1, 2].

---

## 3. llama.cpp Optimization & Deployment Guide
Optimize compilation and running flags to extract maximum throughput (tokens per second) and minimize memory utilization[cite: 1, 2].

### Recommended Startup Script
Deploy your model using this standardized CLI pattern[cite: 1, 2]:

```bash
./llama-cli \
  -m models/qwen3-32b-instruct-Q4_K_M.gguf \
  -ngl 99 \
  -c 32768 \
  -t 8 \
  -fa \
  --flash-attn
  ```