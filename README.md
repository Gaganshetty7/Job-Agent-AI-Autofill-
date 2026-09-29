# JobAgent — AI Job Application Autofill

JobAgent is an AI-powered Chrome Extension designed to intelligently automate and streamline the job application process. 

Unlike traditional autofill tools that rely on static HTML attributes, JobAgent uses AI (powered by a Python/FastAPI backend) to semantically understand the context of each form field (labels, placeholders, nearby text) and match it to your personal profile.

## Key Features

- **Semantic AI Matching:** Uses Gemini or Claude to understand exactly what a form field is asking for, even if it's phrased unusually.
- **Manual Control Flow:** Click the JobAgent orb on any page and click **Scan Page** to initiate the AI mapping process.
- **Confidence-based Autofill:** 
  - **Autofill:** Highly confident matches are filled automatically.
  - **Review:** Ambiguous fields prompt you to select the correct value.
  - **Unmapped:** Unknown fields ask you to manually map them to a profile key.
- **Safety First:** The extension deliberately detects subjective "Judgment" fields (salary expectations, sponsorship, cover letters, demographics) and **never** auto-fills them.
- **Continuous Learning:** When you manually map a field or make a correction, JobAgent saves that exact HTML layout locally. The next time you encounter it, it skips the AI and uses your saved mapping.

---

## Setup Instructions

### 1. Backend Setup (Python / FastAPI)

1. Open the project folder in your terminal.
2. Create a `.env` file in the root directory and add your API keys:
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   ANTHROPIC_API_KEY=your_claude_api_key_here
   ```
3. Activate your Python environment (optional but recommended).
4. Install the required dependencies:
   ```bash
   cd backend
   pip install -r requirements.txt
   ```
5. Start the backend server:
   ```bash
   python -m uvicorn main:app --reload --port 8000
   ```

### 2. Extension Setup (Chrome)

1. Open Google Chrome and navigate to `chrome://extensions`.
2. Toggle **Developer mode** in the top right corner.
3. Click **Load unpacked** and select the `extension/` folder from this project.
4. Pin the JobAgent extension to your toolbar.
5. Click the JobAgent extension icon to open the **Settings** page:
   - Ensure the Backend URL is set to `http://localhost:8000`.
   - Select your preferred AI Provider (Gemini or Claude) and Model.
   - Click **Save**.

### 3. Usage

1. Navigate to any job application page.
2. Click the floating purple **✦ JobAgent orb** in the bottom right corner of the screen.
3. Click **Scan Page**.
4. The extension will scrape the form fields, consult the AI backend, and guide you through the process of Auto-filling, Resolving Conflicts, and Mapping new fields!

---

## Switching AI Models
JobAgent allows you to switch between Gemini and Claude on the fly. You do not need to restart the backend or reload the extension. Simply open the extension Settings (via the toolbar icon or the gear icon in the orb panel), select a new model, and click Save. The very next field scan will use the new model.
