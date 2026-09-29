"""
JobAgent backend — matches job-application form fields and pairs them against a canonical
profile schema. Supports two interchangeable providers, switched per-request
by the extension's options page: Google Gemini and Anthropic Claude.

Run:
    pip install -r requirements.txt
    export GEMINI_API_KEY=...      # only needed if you use the gemini provider
    export ANTHROPIC_API_KEY=...   # only needed if you use the anthropic provider
    uvicorn main:app --reload --port 8000
"""

import json
import os
import asyncio
from pathlib import Path
from typing import List, Literal, Optional

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv(Path(__file__).resolve().parents[1] / ".env")

app = FastAPI(title="JobAgent Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # chrome-extension:// origins vary per install; tighten for prod
    allow_methods=["*"],
    allow_headers=["*"],
)

MATCH_SYSTEM_PROMPT = """You are an HTML parser. Extract the full human-readable field name (label) from each provided HTML bubble. 
If an HTML comment starting with 'Target Field Hints' is provided at the top, combine those native attributes with the surrounding HTML text to determine the specific field name (e.g. 'Date of Birth - Month :'). 
Extract the label specifically for the element marked with data-jobagent-target="true".
Output ONLY a JSON array of strings in the exact same order. Do NOT output confidence scores."""

PAIR_SYSTEM_PROMPT = """You are a semantic pairing engine. Map the extracted field names to the user's EXISTING canonical profile keys. 1.0 confidence for exact word match, 0.8 for strong semantic, 0.4 for weak. If no match, use 'unknown' with 0.0 confidence. Output JSON array: [{"index": i, "key": "mapped_key", "confidence": 0.0-1.0}]."""

SUBMIT_PAIR_SYSTEM_PROMPT = """You are a semantic pairing engine. Map the extracted field names to the user's EXISTING canonical profile keys. 1.0 confidence for exact word match, 0.8 for strong semantic, 0.4 for weak. If no match, use 'unknown' with 0.0 confidence. Output JSON array: [{"index": i, "key": "mapped_key", "confidence": 0.0-1.0}].
If the field represents reusable personal data NOT in existing keys, INVENT a new generic snake_case key with high confidence. For company-specific/judgment questions, map to 'unknown' with 0.0."""

class MatchRequest(BaseModel):
    html_bubbles: List[str]

class MatchResponse(BaseModel):
    field_names: List[str]

class PairRequest(BaseModel):
    field_names: List[str]
    profile_keys: List[str]

class PairMapping(BaseModel):
    index: int
    key: str
    confidence: float

class PairResponse(BaseModel):
    mappings: List[PairMapping]

class SubmitPairRequest(BaseModel):
    field_names: List[str]
    values: List[str]
    profile_keys: List[str]
    current_profile: dict

class SubmitPairResponse(BaseModel):
    mappings: List[PairMapping]

def get_model_config(phase: str):
    cfg_path = Path(__file__).parent / "config.json"
    try:
        with open(cfg_path, "r") as f:
            return json.load(f).get("models", {}).get(phase, {"provider": "gemini", "model": "gemini-2.5-flash-lite"})
    except Exception:
        return {"provider": "gemini", "model": "gemini-2.5-flash-lite"}

def build_match_prompt(req: MatchRequest) -> str:
    return json.dumps({"html_bubbles": req.html_bubbles}, indent=2)

def build_pair_prompt(req: PairRequest) -> str:
    return json.dumps({
        "field_names": req.field_names,
        "allowed_keys": req.profile_keys + ["unknown"]
    }, indent=2)

def build_submit_pair_prompt(req: SubmitPairRequest) -> str:
    return json.dumps({
        "fields": [
            {"index": i, "field_name": name, "value": val}
            for i, (name, val) in enumerate(zip(req.field_names, req.values))
        ],
        "allowed_keys": req.profile_keys + ["unknown"],
        "current_profile": req.current_profile
    }, indent=2)

def parse_match_response(raw: str, count: int) -> MatchResponse:
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned.replace("json\n", "", 1) if cleaned.startswith("json\n") else cleaned
    try:
        data = json.loads(cleaned)
        if not isinstance(data, list):
            data = [data]
        results = [str(x) for x in data]
        while len(results) < count:
            results.append("unknown")
        return MatchResponse(field_names=results[:count])
    except Exception:
        return MatchResponse(field_names=["unknown" for _ in range(count)])

def parse_pair_response(raw: str, count: int) -> List[PairMapping]:
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned.replace("json\n", "", 1) if cleaned.startswith("json\n") else cleaned
    try:
        data = json.loads(cleaned)
        if not isinstance(data, list):
            data = [data]
        mappings = []
        for item in data:
            mappings.append(PairMapping(
                index=int(item.get("index", len(mappings))),
                key=item.get("key", "unknown"),
                confidence=float(item.get("confidence", 0.0)),
            ))
        while len(mappings) < count:
            mappings.append(PairMapping(index=len(mappings), key="unknown", confidence=0.0))
        return mappings[:count]
    except Exception:
        return [PairMapping(index=i, key="unknown", confidence=0.0) for i in range(count)]

async def call_gemini_base(prompt: str, model: str, system_prompt: str) -> str:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(500, "GEMINI_API_KEY is not set on the backend")

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    payload = {
        "system_instruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "temperature": 0,
        },
    }
    
    max_retries = 3
    base_delay = 2.0
    
    async with httpx.AsyncClient(timeout=60.0) as client:
        for attempt in range(max_retries + 1):
            try:
                resp = await client.post(url, json=payload)
            except httpx.RequestError as e:
                if attempt < max_retries:
                    await asyncio.sleep(base_delay * (2 ** attempt))
                    continue
                raise HTTPException(500, f"Gemini network error: {str(e)}")
            
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < max_retries:
                await asyncio.sleep(base_delay * (2 ** attempt))
                continue
            if resp.status_code != 200:
                raise HTTPException(resp.status_code, f"Gemini error: {resp.text}")
            
            data = resp.json()
            return data["candidates"][0]["content"]["parts"][0]["text"]

async def call_anthropic_base(prompt: str, model: str, system_prompt: str) -> str:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise HTTPException(500, "ANTHROPIC_API_KEY is not set on the backend")

    url = "https://api.anthropic.com/v1/messages"
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    payload = {
        "model": model,
        "max_tokens": 1000,
        "system": system_prompt,
        "messages": [{"role": "user", "content": prompt}],
    }
    
    max_retries = 3
    base_delay = 2.0
    
    async with httpx.AsyncClient(timeout=60.0) as client:
        for attempt in range(max_retries + 1):
            try:
                resp = await client.post(url, headers=headers, json=payload)
            except httpx.RequestError as e:
                if attempt < max_retries:
                    await asyncio.sleep(base_delay * (2 ** attempt))
                    continue
                raise HTTPException(500, f"Anthropic network error: {str(e)}")
            
            if resp.status_code in (429, 500, 502, 503, 504) and attempt < max_retries:
                await asyncio.sleep(base_delay * (2 ** attempt))
                continue
            if resp.status_code != 200:
                raise HTTPException(resp.status_code, f"Anthropic error: {resp.text}")
            
            data = resp.json()
            return "".join(block.get("text", "") for block in data.get("content", []) if block.get("type") == "text")

async def call_gemini_match(req: MatchRequest, model: str) -> MatchResponse:
    text = await call_gemini_base(build_match_prompt(req), model, MATCH_SYSTEM_PROMPT)
    return parse_match_response(text, len(req.html_bubbles))

async def call_anthropic_match(req: MatchRequest, model: str) -> MatchResponse:
    text = await call_anthropic_base(build_match_prompt(req), model, MATCH_SYSTEM_PROMPT)
    return parse_match_response(text, len(req.html_bubbles))

async def call_gemini_pair(req: PairRequest, model: str) -> PairResponse:
    text = await call_gemini_base(build_pair_prompt(req), model, PAIR_SYSTEM_PROMPT)
    return PairResponse(mappings=parse_pair_response(text, len(req.field_names)))

async def call_anthropic_pair(req: PairRequest, model: str) -> PairResponse:
    text = await call_anthropic_base(build_pair_prompt(req), model, PAIR_SYSTEM_PROMPT)
    return PairResponse(mappings=parse_pair_response(text, len(req.field_names)))

async def call_gemini_pair_submitted(req: SubmitPairRequest, model: str) -> SubmitPairResponse:
    text = await call_gemini_base(build_submit_pair_prompt(req), model, SUBMIT_PAIR_SYSTEM_PROMPT)
    return SubmitPairResponse(mappings=parse_pair_response(text, len(req.field_names)))

async def call_anthropic_pair_submitted(req: SubmitPairRequest, model: str) -> SubmitPairResponse:
    text = await call_anthropic_base(build_submit_pair_prompt(req), model, SUBMIT_PAIR_SYSTEM_PROMPT)
    return SubmitPairResponse(mappings=parse_pair_response(text, len(req.field_names)))

MATCH_PROVIDERS = {
    "gemini": call_gemini_match,
    "anthropic": call_anthropic_match,
}

PAIR_PROVIDERS = {
    "gemini": call_gemini_pair,
    "anthropic": call_anthropic_pair,
}

SUBMIT_PAIR_PROVIDERS = {
    "gemini": call_gemini_pair_submitted,
    "anthropic": call_anthropic_pair_submitted,
}

@app.post("/match", response_model=MatchResponse)
async def match_endpoint(req: MatchRequest):
    cfg = get_model_config("matching")
    handler = MATCH_PROVIDERS.get(cfg["provider"])
    if not handler:
        raise HTTPException(400, f"Unknown provider '{cfg['provider']}'.")
    return await handler(req, cfg["model"])

@app.post("/pair", response_model=PairResponse)
async def pair_endpoint(req: PairRequest):
    cfg = get_model_config("pairing")
    handler = PAIR_PROVIDERS.get(cfg["provider"])
    if not handler:
        raise HTTPException(400, f"Unknown provider '{cfg['provider']}'.")
    return await handler(req, cfg["model"])

@app.post("/pair-submitted", response_model=SubmitPairResponse)
async def pair_submitted_endpoint(req: SubmitPairRequest):
    cfg = get_model_config("pairing")
    handler = SUBMIT_PAIR_PROVIDERS.get(cfg["provider"])
    if not handler:
        raise HTTPException(400, f"Unknown provider '{cfg['provider']}'.")
    return await handler(req, cfg["model"])

@app.get("/health")
async def health():
    return {"status": "ok", "providers": list(MATCH_PROVIDERS)}
