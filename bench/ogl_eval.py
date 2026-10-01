#!/usr/bin/env python3
"""OGL execution eval: does the routed-down model handle niche-library work?

Matrix: {glm-5.3-flash, glm-5.3} x {ogl, three} — same artifact prompt per
framework, generated via the z.ai subscription, then judged headlessly
(agent-browser): JS errors, canvas present, non-blank render, animation.

  python3 bench/ogl_eval.py generate   # 4 artifacts into bench/ogl/
  python3 bench/ogl_eval.py judge      # headless render + verdicts
  python3 bench/ogl_eval.py all

This is the knowledge-depth hard-example set: OGL (oframe/ogl) is a niche
three.js alternative models are less trained on; three.js is the control.
"""
import json, os, re, sys, urllib.request

AUTH = os.path.expanduser("~/.pi/agent/auth.json")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ogl")
API = "https://api.z.ai/api/paas/v4/chat/completions"

PROMPTS = {
    "ogl": (
        "Create a complete, self-contained index.html that renders a rotating 3D torus knot "
        "using OGL (https://github.com/oframe/ogl). Import OGL from a CDN such as "
        "https://esm.sh/ogl or https://unpkg.com/ogl. Dark background, the knot centered and "
        "filling most of the view, continuously rotating via requestAnimationFrame. "
        "Use OGL's real API (Renderer, Camera, Program, Mesh, Geometry/ Torus geometry if available, "
        "Transform, Orbit is optional). Output ONLY the HTML file content, no explanations."
    ),
    "three": (
        "Create a complete, self-contained index.html that renders a rotating 3D torus knot "
        "using three.js. Import three.js from a CDN such as https://esm.sh/three. Dark background, "
        "the knot centered and filling most of the view, continuously rotating via the animation loop. "
        "Use three.js's real API (WebGLRenderer, Scene, PerspectiveCamera, TorusKnotGeometry, MeshNormalMaterial). "
        "Output ONLY the HTML file content, no explanations."
    ),
}

def cmd_generate():
    """Generate via pi itself (the working, subscribed channel)."""
    import subprocess, time
    models = [("glm-5.3-flash", "zai/glm-5.3-flash"), ("glm-5.3", "zai/glm-5.3")]
    os.makedirs(OUT, exist_ok=True)
    for label, model_id in models:
        for fw in ("ogl", "three"):
            name = f"{label.replace('.', '')}-{fw}.html"
            path = os.path.join(OUT, name)
            if os.path.exists(path) and os.path.getsize(path) > 500:
                print(f"skip {name} (exists)"); continue
            workdir = os.path.join(OUT, f"work-{label}-{fw}")
            os.makedirs(workdir, exist_ok=True)
            prompt = PROMPTS[fw] + "\n\nWrite the result to the file index.html in the current directory using the write tool."
            print(f"generating {name} via pi ({model_id}) ...", flush=True)
            t0 = time.time()
            try:
                subprocess.run(["pi", "-p", "--mode", "json", "-ne", "--model", model_id, prompt],
                               cwd=workdir, timeout=480, capture_output=True)
            except subprocess.TimeoutExpired:
                print("  TIMEOUT 480s")
            artifact = os.path.join(workdir, "index.html")
            if os.path.exists(artifact) and os.path.getsize(artifact) > 300:
                content = open(artifact).read()
                open(path, "w").write(content)
                lo = "three" in content.lower(); og = "ogl" in content.lower()
                print(f"  {len(content)} bytes in {time.time()-t0:.0f}s | three={lo} ogl={og}")
            else:
                print(f"  NO ARTIFACT produced")

def cmd_judge():
    import subprocess, time
    results = {}
    ab = "agent-browser"
    for f in sorted(os.listdir(OUT)):
        if not f.endswith(".html"): continue
        path = os.path.abspath(os.path.join(OUT, f))
        base = f[:-5]
        subprocess.run([ab, "open", f"file://{path}"], capture_output=True, timeout=60)
        time.sleep(3.5)  # CDN import + first frames
        errs = subprocess.run([ab, "errors"], capture_output=True, text=True, timeout=30).stdout.strip()
        cons = subprocess.run([ab, "console"], capture_output=True, text=True, timeout=30).stdout.strip()
        s1 = os.path.join(OUT, f"{base}-f1.png"); s2 = os.path.join(OUT, f"{base}-f2.png")
        subprocess.run([ab, "screenshot", s1], capture_output=True, timeout=30)
        time.sleep(1.3)
        subprocess.run([ab, "screenshot", s2], capture_output=True, timeout=30)
        animated = False; blank = True
        try:
            if os.path.exists(s1) and os.path.exists(s2):
                b1, b2 = open(s1, "rb").read(), open(s2, "rb").read()
                animated = len(b1) > 8000 and b1 != b2
                blank = len(b1) <= 8000
        except Exception:
            pass
        js_errors = len([l for l in errs.splitlines() if l.strip()]) if errs.lower() != "no page errors" else 0
        results[f] = {"js_errors": js_errors, "animated": animated, "blank": blank,
                      "errors_excerpt": errs[:150], "console_excerpt": cons[:150]}
        print(f"{f:32s} js_errors={js_errors} animated={animated} blank={blank}")
        if js_errors: print(f"   errors: {errs[:150]}")
    print("\n=== VERDICTS (pass = 0 js errors, renders, animates) ===")
    for f, r in results.items():
        ok = r["js_errors"] == 0 and r["animated"] and not r["blank"]
        print(f"{'PASS' if ok else 'FAIL'}  {f}")

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "all"
    if cmd in ("generate", "all"): cmd_generate()
    if cmd in ("judge", "all"): cmd_judge()
