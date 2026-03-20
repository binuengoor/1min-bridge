# 1min.ai GitHub Repositories Analysis

## 1. anjog/1min-proxy

### What it does
An OpenAI-compatible proxy for the 1min.ai API that uses the new Chat-with-AI API (UNIFY_CHAT_WITH_AI). It acts as a middleman, translating standard OpenAI chat completion requests (including streaming and image uploads) into the 1min.ai format. Crucially, it provides a functional emulation layer for function calling, which the native 1min.ai API does not support.

### Architecture
- **Language**: Python 3.11+
- **Framework**: Flask (with Waitress as the WSGI server)
- **Deployment**: Supports systemd (system/user) and OpenWRT procd. Runs directly via Python virtual environment.
- **Key components**: Rate limiting (Memcached/in-memory), dynamic model registry via 1min.ai/models, and regex-based output parsing for function calling.

### Does it solve a problem 1min-bridge doesn't?
Yes. The most significant feature is **Function-calling emulation**. 1min-bridge (being an OpenAI-compatible relay) likely faces the same limitation where 1min.ai natively drops or doesn't understand OpenAI tool definitions. 1min-proxy handles this by:
1. Injecting tool descriptions into the system prompt.
2. Instructing the model to output tool calls in specific formats (XML/JSON).
3. Intercepting the streaming/non-streaming response, parsing out the tool calls, and re-wrapping them into valid OpenAI tool_calls format for the client.

### Unique features / API knowledge to reuse
- **Function Calling Emulation**: The logic in function_calling.py is highly valuable. It maps how to serialize tools into a system prompt and provides regex patterns to catch various model-specific tool call outputs (e.g., Anthropic XML, DeepSeek tokens, Mistral arrays).
- **New API Structure**: Uses /api/chat-with-ai (type UNIFY_CHAT_WITH_AI) instead of the legacy /api/features. It documents that the new API uses structured SSE events, whereas the old one used raw byte streams.
- **Image Uploads**: Demonstrates how to upload images to the 1min.ai Asset API (/api/assets) and inject the returned path into the chat payload.
- **Crawling Filter**: Includes a regex to strip out unwanted UI text that 1min.ai injects into responses (e.g. 🌐 Crawling site).
- **Credit Cost Logging**: Extracts metadata from the result to estimate credit usage.

### Code Quality
The code is clean, modular, and well-documented. Separation of concerns is evident (e.g., model_registry.py, function_calling.py, main.py). The approach to parsing SSE events and emulating function calls is robust and accounts for various edge cases across different LLM families.

---

## 2. pstraebler/1minAI-autologin

### What it does
A simple Selenium-based web scraper that automatically logs into app.1min.ai using a Chrome or Firefox webdriver. Its primary purpose is to farm the daily free credits that 1min.ai awards for logging in.

### Architecture
- **Language**: Python
- **Framework**: Selenium
- **Deployment**: Local script execution, supports headless mode.

### Does it solve a problem 1min-bridge doesn't?
No. This is purely a UI automation script for farming daily credits, not an API utility. 1min-bridge is focused on API relaying, not account management via web scraping.

### Unique features / API knowledge to reuse
- **None for the bridge itself.** It relies on hardcoded XPath/CSS selectors to navigate the React UI (Ant Design) to click the login button and fill in credentials.

### Code Quality
Basic and functional script. It lacks robust error handling (e.g., if the UI changes, the script breaks). It uses hardcoded sleep times instead of explicit waits for element visibility, making it brittle.

---

## Recommendations for 1min-bridge

1. **Adopt Function-Calling Emulation**: The biggest takeaway is from 1min-proxy. We should port the logic from function_calling.py into our TypeScript/Hono implementation. This involves:
   - Modifying the incoming OpenAI request to inject tools into the system prompt.
   - Parsing the outgoing stream/response from 1min.ai to detect XML/JSON tool calls and converting them back to OpenAI format.
2. **Implement Crawling Filter**: Add a regex filter to strip unwanted lines from the output stream to ensure clean text for the client.
3. **Verify API Endpoints**: Ensure 1min-bridge is using the modern /api/chat-with-ai endpoint with SSE, rather than the legacy endpoint.
4. **Ignore Autologin**: Do not incorporate anything from 1minAI-autologin. Account credit farming via Selenium is out of scope and too brittle for an API bridge.
