import json
import logging
import os
import sys
import traceback

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

WHISPER_LANGUAGES = {
    "en": "english", "zh": "chinese", "de": "german", "es": "spanish",
    "ru": "russian", "ko": "korean", "fr": "french", "ja": "japanese",
    "pt": "portuguese", "tr": "turkish", "pl": "polish", "ca": "catalan",
    "nl": "dutch", "ar": "arabic", "sv": "swedish", "it": "italian",
    "id": "indonesian", "hi": "hindi", "fi": "finnish", "vi": "vietnamese",
    "he": "hebrew", "uk": "ukrainian", "el": "greek", "ms": "malay",
    "cs": "czech", "ro": "romanian", "da": "danish", "hu": "hungarian",
    "ta": "tamil", "no": "norwegian", "th": "thai", "ur": "urdu",
    "hr": "croatian", "bg": "bulgarian", "lt": "lithuanian", "la": "latin",
    "mi": "maori", "ml": "malayalam", "cy": "welsh", "sk": "slovak",
    "te": "telugu", "fa": "persian", "lv": "latvian", "bn": "bengali",
    "sr": "serbian", "az": "azerbaijani", "sl": "slovenian", "kn": "kannada",
    "et": "estonian", "mk": "macedonian", "br": "breton", "eu": "basque",
    "is": "icelandic", "hy": "armenian", "ne": "nepali", "mn": "mongolian",
    "bs": "bosnian", "kk": "kazakh", "sq": "albanian", "sw": "swahili",
    "gl": "galician", "mr": "marathi", "pa": "punjabi", "si": "sinhala",
    "km": "khmer", "sn": "shona", "yo": "yoruba", "so": "somali",
    "af": "afrikaans", "oc": "occitan", "ka": "georgian", "be": "belarusian",
    "tg": "tajik", "sd": "sindhi", "gu": "gujarati", "am": "amharic",
    "yi": "yiddish", "lo": "lao", "uz": "uzbek", "fo": "faroese",
    "ht": "haitian creole", "ps": "pashto", "tk": "turkmen", "nn": "nynorsk",
    "mt": "maltese", "sa": "sanskrit", "lb": "luxembourgish", "my": "myanmar",
    "bo": "tibetan", "tl": "tagalog", "mg": "malagasy", "as": "assamese",
    "tt": "tatar", "haw": "hawaiian", "ln": "lingala", "ha": "hausa",
    "ba": "bashkir", "jw": "javanese", "su": "sundanese",
}
NAME_TO_CODE = {name: code for code, name in WHISPER_LANGUAGES.items()}
NAME_TO_CODE.update({
    "mandarin": "zh", "mandarin chinese": "zh", "simplified chinese": "zh",
    "traditional chinese": "zh", "farsi": "fa", "burmese": "my",
    "haitian": "ht", "haitian creole": "ht", "bokmal": "no",
})
LANG_ALIASES = {
    "iw": "he", "jw": "jv", "jv": "jv", "zh-cn": "zh", "zh-tw": "zh",
    "pt-br": "pt", "pt-pt": "pt", "fil": "tl",
}

_available_cache = None
_madlad_translator = None
_madlad_tokenizer = None
_madlad_device = None
_madlad_codes = None


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def progress(message):
    emit({"event": "progress", "message": message})


def normalize(code):
    value = str(code or "").strip().lower().replace("_", "-")
    if not value:
        return ""
    if value in NAME_TO_CODE:
        value = NAME_TO_CODE[value]
    value = LANG_ALIASES.get(value, value)
    short = value.split("-")[0]
    if short == "jw":
        short = "jv"
    return short


def load_modules():
    import argostranslate.package as package
    import argostranslate.translate as translate
    return package, translate


def madlad_model_dir():
    return os.environ.get("INK_MADLAD_MODEL", "")


def madlad_tokenizer_path():
    root = madlad_model_dir()
    for name in ("spiece.model", "sentencepiece.model"):
        candidate = os.path.join(root, name)
        if os.path.isfile(candidate):
            return candidate
    return ""


def madlad_ready():
    root = madlad_model_dir()
    return bool(root and os.path.isfile(os.path.join(root, "model.bin")) and madlad_tokenizer_path())


def load_madlad():
    global _madlad_translator, _madlad_tokenizer, _madlad_device
    if _madlad_translator is not None and _madlad_tokenizer is not None:
        return _madlad_translator, _madlad_tokenizer, _madlad_device
    if not madlad_ready():
        raise RuntimeError("The high-quality translation model is not installed. Open Ink Settings and install it once.")

    import ctranslate2
    from sentencepiece import SentencePieceProcessor

    root = madlad_model_dir()
    tokenizer = SentencePieceProcessor()
    tokenizer.load(madlad_tokenizer_path())

    requested = str(os.environ.get("ARGOS_DEVICE_TYPE", "auto") or "auto").lower()
    devices = ["cpu"] if requested == "cpu" else ["cuda", "cpu"]
    last_error = None
    for device in devices:
        try:
            progress(f"Loading high-quality translator on {device.upper()}…")
            translator = ctranslate2.Translator(
                root,
                device=device,
                compute_type="auto",
                inter_threads=1,
                intra_threads=0,
            )
            _madlad_translator = translator
            _madlad_tokenizer = tokenizer
            _madlad_device = device
            progress(f"High-quality translator ready on {device.upper()}.")
            return translator, tokenizer, device
        except Exception as exc:
            last_error = exc
            if device == "cuda":
                progress("High-quality GPU translation is unavailable; falling back to CPU…")
    raise RuntimeError(str(last_error or "Could not load the high-quality translation model."))


def madlad_language_codes():
    global _madlad_codes
    if _madlad_codes is not None:
        return _madlad_codes
    if not madlad_ready():
        return []
    try:
        from sentencepiece import SentencePieceProcessor
        tokenizer = SentencePieceProcessor()
        tokenizer.load(madlad_tokenizer_path())
        codes = set()
        # MADLAD language tags live at the beginning of the vocabulary. Checking the
        # first 1024 pieces avoids scanning a 256K vocabulary every time Settings opens.
        limit = min(1024, tokenizer.get_piece_size())
        for i in range(limit):
            piece = tokenizer.id_to_piece(i)
            if piece.startswith("<2") and piece.endswith(">") and 3 < len(piece) < 16:
                codes.add(normalize(piece[2:-1]))
        _madlad_codes = sorted(code for code in codes if code)
    except Exception:
        _madlad_codes = []
    return _madlad_codes


def text_unit_count(text):
    import re
    # Unicode-aware word-like units. This is intentionally simple: it works for
    # Swedish/English/Arabic/Cyrillic and is only used as a hallucination guard.
    units = re.findall(r"[^\W_]+(?:['’\-][^\W_]+)*", str(text or ""), flags=re.UNICODE)
    return len(units)


def translation_looks_expanded(source_text, translated_text):
    source_units = max(1, text_unit_count(source_text))
    translated_units = text_unit_count(translated_text)
    if not translated_units:
        return True

    # Short translations should not suddenly grow into paragraphs. Languages can
    # legitimately expand relative to one another, so keep generous headroom while
    # still catching the failure we observed where one 12-word sentence became 30+
    # words of invented content.
    if source_units <= 4:
        allowed = max(12, source_units * 3)
    else:
        # 55% expansion plus a few function words is already generous for normal
        # sentence translation, but catches the observed 14-word → 25-word Arabic
        # hallucination before it reaches the clipboard.
        allowed = int(source_units * 1.55) + 3
    return translated_units > allowed


def translate_madlad_once(text, target, conservative=False):
    target = normalize(target)
    clean = str(text or "").strip()
    if not clean:
        return ""
    translator, tokenizer, device = load_madlad()
    input_tokens = tokenizer.encode(f"<2{target}> {clean}", out_type=str)

    # 0.2.7 accidentally used no_repeat_ngram_size=1. That forbids *any* token from
    # appearing twice, which is far too aggressive for natural language and can push
    # beam search into bizarre continuations. Use a normal trigram guard instead and
    # cap generation relative to the source length so a short sentence cannot turn
    # into an invented paragraph.
    multiplier = 1.65 if conservative else 2.15
    extra = 10 if conservative else 16
    max_decode = min(256, max(24, int(len(input_tokens) * multiplier) + extra))
    results = translator.translate_batch(
        [input_tokens],
        batch_type="tokens",
        beam_size=4 if conservative else 3,
        no_repeat_ngram_size=3,
        repetition_penalty=1.03,
        max_decoding_length=max_decode,
    )
    return tokenizer.decode(results[0].hypotheses[0]).strip()


ARABIC_TARGET_CODES = {
    "ar", "arb", "arz", "ary", "apc", "ajp", "acm", "afb", "ars", "aeb", "arq", "shu"
}


def translate_madlad(text, target, source="auto"):
    target = normalize(target)
    source = normalize(source)
    clean = str(text or "").strip()
    if not clean:
        return {"text": "", "validated": True, "strategy": "empty"}

    # First prefer a direct translation. Earlier builds always forced Arabic pairs
    # through English; that added another generation step and could amplify errors.
    progress(f"Translating directly to {target} with MADLAD-400…")
    direct = translate_madlad_once(clean, target, conservative=False)
    if direct and not translation_looks_expanded(clean, direct):
        return {"text": direct, "validated": True, "strategy": "direct"}

    progress("Translation looked unusually long; retrying with conservative decoding…")
    retry = translate_madlad_once(clean, target, conservative=True)
    if retry and not translation_looks_expanded(clean, retry):
        return {"text": retry, "validated": True, "strategy": "direct-conservative"}

    # Arabic pairs are difficult enough that an English semantic bridge is still a
    # useful fallback, but only after direct decoding has failed the safety check.
    arabic_pair = source in ARABIC_TARGET_CODES or target in ARABIC_TARGET_CODES
    if arabic_pair and source != "en" and target != "en":
        progress("Direct Arabic translation failed the safety check; trying an English semantic bridge…")
        english = translate_madlad_once(clean, "en", conservative=True)
        if english and not translation_looks_expanded(clean, english):
            bridged = translate_madlad_once(english, target, conservative=True)
            if bridged and not translation_looks_expanded(clean, bridged):
                return {"text": bridged, "validated": True, "strategy": "english-bridge"}

    candidate = retry or direct
    return {"text": candidate, "validated": False, "strategy": "failed-safety-check"}


def clear_language_cache(translate):
    try:
        translate.get_installed_languages.cache_clear()
    except Exception:
        pass


def get_available(package, refresh=False):
    global _available_cache
    if refresh or _available_cache is None:
        if refresh:
            progress("Updating the local language-pack catalog…")
            package.update_package_index()
        try:
            _available_cache = package.get_available_packages()
        except Exception:
            package.update_package_index()
            _available_cache = package.get_available_packages()
    return _available_cache


def installed_route(translate, source, target):
    try:
        return translate.get_translation_from_codes(source, target) is not None
    except Exception:
        return False


def install_package(package_mod, translate_mod, pkg):
    progress(f"Downloading {pkg.from_name} → {pkg.to_name} language pack…")
    download_path = pkg.download()
    package_mod.install_from_path(download_path)
    clear_language_cache(translate_mod)
    progress(f"Installed {pkg.from_name} → {pkg.to_name}.")


def find_package(available, source, target):
    for pkg in available:
        if normalize(pkg.from_code) == source and normalize(pkg.to_code) == target:
            return pkg
    return None


def ensure_route(package_mod, translate_mod, source, target, available=None):
    source = normalize(source)
    target = normalize(target)
    if not source or source == "auto":
        raise RuntimeError("Ink could not determine the source language for translation.")
    if source == target:
        return {"mode": "same", "source": source, "target": target}
    if installed_route(translate_mod, source, target):
        return {"mode": "direct", "source": source, "target": target}

    available = available if available is not None else get_available(package_mod, refresh=False)
    direct = find_package(available, source, target)
    if direct is not None:
        install_package(package_mod, translate_mod, direct)
        if installed_route(translate_mod, source, target):
            return {"mode": "direct", "source": source, "target": target}

    if source == "en" or target == "en":
        raise RuntimeError(f"Ink installed the available pack, but the {source} → {target} route is still unavailable.")

    if not installed_route(translate_mod, source, "en"):
        src_en = find_package(available, source, "en")
        if src_en is None:
            raise RuntimeError(f"No offline language pack is currently available for {source} → English.")
        install_package(package_mod, translate_mod, src_en)

    if not installed_route(translate_mod, "en", target):
        en_target = find_package(available, "en", target)
        if en_target is None:
            raise RuntimeError(f"No offline language pack is currently available for English → {target}.")
        install_package(package_mod, translate_mod, en_target)

    clear_language_cache(translate_mod)
    if not installed_route(translate_mod, source, "en"):
        raise RuntimeError(f"The {source} → English language pack was installed, but Argos did not load it.")
    if not installed_route(translate_mod, "en", target):
        raise RuntimeError(f"The English → {target} language pack was installed, but Argos did not load it.")
    return {"mode": "pivot", "source": source, "target": target, "pivot": "en"}


def translate_with_route(translate_mod, text, route):
    mode = route.get("mode")
    source = route.get("source")
    target = route.get("target")
    if mode == "same":
        return text
    if mode == "direct":
        return translate_mod.translate(text, source, target)
    if mode == "pivot":
        pivot = route.get("pivot") or "en"
        progress(f"Translating {source} → {pivot} → {target}…")
        intermediate = translate_mod.translate(text, source, pivot)
        return translate_mod.translate(intermediate, pivot, target)
    raise RuntimeError("Ink could not resolve an offline translation route.")


def list_languages(package_mod, refresh=False):
    names = {}
    pairs = []
    try:
        available = get_available(package_mod, refresh=refresh)
        for pkg in available:
            src = normalize(pkg.from_code)
            dst = normalize(pkg.to_code)
            if not src or not dst:
                continue
            names.setdefault(src, str(pkg.from_name or src))
            names.setdefault(dst, str(pkg.to_name or dst))
            pairs.append([src, dst])
    except Exception:
        pass

    # Once MADLAD is installed, expose its broad target-language set too. Electron's
    # Intl.DisplayNames turns unfamiliar ISO codes into readable names in Settings.
    for code in madlad_language_codes():
        names.setdefault(code, code)

    languages = [
        {"code": code, "name": name}
        for code, name in sorted(names.items(), key=lambda item: item[1].casefold())
    ]
    return {"languages": languages, "pairs": pairs, "qualityModelReady": madlad_ready()}


def prepare_target(package_mod, translate_mod, target):
    target = normalize(target)
    if not target:
        raise RuntimeError("Choose a target language first.")
    if madlad_ready():
        # MADLAD is one multilingual pack: no pair-specific download is necessary.
        return {"target": target, "preparedRoutes": ["madlad"], "qualityModel": True}

    available = get_available(package_mod, refresh=True)
    prepared = []
    for source, destination in (("en", target), (target, "en")):
        if source == destination:
            continue
        try:
            ensure_route(package_mod, translate_mod, source, destination, available)
            prepared.append(f"{source}->{destination}")
        except Exception as exc:
            progress(str(exc))
    return {"target": target, "preparedRoutes": prepared, "qualityModel": False}


def merge_adjacent_segments(segments):
    merged = []
    for segment in segments or []:
        text = str(segment.get("text") or "").strip()
        source = normalize(segment.get("language"))
        if not text:
            continue
        if not source or source == "auto":
            source = "auto"
        if merged and merged[-1]["language"] == source:
            merged[-1]["text"] = (merged[-1]["text"] + " " + text).strip()
        else:
            merged.append({"text": text, "language": source})
    return merged


def translate_segments_argos(package_mod, translate_mod, segments, target, auto_install=True):
    target = normalize(target)
    merged_segments = merge_adjacent_segments(segments)
    available = None
    output = []
    for segment in merged_segments:
        text = segment["text"]
        source = segment["language"]
        if not source or source == "auto":
            raise RuntimeError("Ink could not determine the source language for one part of this dictation.")
        if source == target:
            output.append({"text": text, "source": source, "target": target})
            continue
        if available is None:
            available = get_available(package_mod, refresh=False)
        if auto_install:
            route = ensure_route(package_mod, translate_mod, source, target, available)
        elif installed_route(translate_mod, source, target):
            route = {"mode": "direct", "source": source, "target": target}
        elif source != "en" and target != "en" and installed_route(translate_mod, source, "en") and installed_route(translate_mod, "en", target):
            route = {"mode": "pivot", "source": source, "target": target, "pivot": "en"}
        else:
            raise RuntimeError(f"The offline {source} → {target} translation route is not installed.")
        if route.get("mode") != "pivot":
            progress(f"Translating {source} → {target}…")
        translated = translate_with_route(translate_mod, text, route)
        output.append({"text": str(translated or "").strip(), "source": source, "target": target})
    final = " ".join(item["text"] for item in output if item["text"]).strip()
    return {"text": final, "segments": output, "target": target, "engine": "argos"}


def translate_segments(package_mod, translate_mod, segments, target, auto_install=True, quality="auto"):
    target = normalize(target)
    if not target:
        raise RuntimeError("Choose a target language first.")

    merged = merge_adjacent_segments(segments)
    whole_text = " ".join(item["text"] for item in merged if item["text"]).strip()
    if not whole_text:
        return {"text": "", "segments": [], "target": target, "engine": "none"}

    all_same_target = bool(merged) and all(item["language"] == target for item in merged if item["language"] != "auto") and all(item["language"] != "auto" for item in merged)
    if all_same_target:
        return {"text": whole_text, "segments": merged, "target": target, "engine": "passthrough"}

    requested = str(quality or "auto").lower()
    if requested in ("quality", "auto") and madlad_ready():
        known_sources = [item["language"] for item in merged if item.get("language") and item["language"] != "auto"]
        source_hint = known_sources[0] if known_sources and all(code == known_sources[0] for code in known_sources) else "auto"
        quality_result = translate_madlad(whole_text, target, source_hint)
        translated = str(quality_result.get("text") or "").strip()
        if translated and quality_result.get("validated"):
            return {
                "text": translated,
                "segments": [{"text": translated, "source": source_hint, "target": target}],
                "target": target,
                "engine": f"madlad:{quality_result.get('strategy') or 'direct'}",
                "device": _madlad_device,
            }

        # Never paste a suspicious high-quality result. Argos is less fluent but is
        # generally conservative and is therefore a better emergency fallback than a
        # hallucinated paragraph. If a route is unavailable, fail visibly instead.
        progress("High-quality translation failed Ink's hallucination guard; trying the conservative offline fallback…")
        try:
            fallback = translate_segments_argos(package_mod, translate_mod, merged, target, auto_install)
            fallback["engine"] = "argos-safety-fallback"
            return fallback
        except Exception as exc:
            raise RuntimeError(
                "Ink blocked a suspicious translation instead of pasting invented text. "
                f"The conservative fallback was unavailable: {exc}"
            )
    if requested == "quality":
        raise RuntimeError("High-quality translation is selected, but the MADLAD model is not installed.")
    return translate_segments_argos(package_mod, translate_mod, merged, target, auto_install)


def handle(message):
    package_mod, translate_mod = load_modules()
    command = message.get("command")
    if command == "languages":
        return list_languages(package_mod, bool(message.get("refresh")))
    if command == "prepare_target":
        return prepare_target(package_mod, translate_mod, message.get("target"))
    if command == "translate":
        return translate_segments(
            package_mod,
            translate_mod,
            message.get("segments") or [],
            message.get("target"),
            bool(message.get("autoInstall", True)),
            message.get("quality") or "auto",
        )
    if command == "warm_quality":
        if madlad_ready():
            _translator, _tokenizer, device = load_madlad()
            return {"ready": True, "device": device}
        return {"ready": False}
    if command == "ping":
        import argostranslate
        return {"version": getattr(argostranslate, "__version__", "unknown"), "qualityModelReady": madlad_ready()}
    raise RuntimeError(f"Unknown translation command: {command}")


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        message = None
        try:
            message = json.loads(line)
            result = handle(message)
            emit({"id": message.get("id"), "ok": True, "result": result})
        except Exception as exc:
            traceback.print_exc(file=sys.stderr)
            emit({"id": message.get("id") if isinstance(message, dict) else None, "ok": False, "error": str(exc)})


if __name__ == "__main__":
    main()
