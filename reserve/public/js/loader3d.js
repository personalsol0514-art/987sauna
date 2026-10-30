/* 987サウナ ローディング：Three.js で厚みのあるロゴが湯気の中で呼吸するように佇み、最後はゆっくり霧に溶けて消える。
   WebGL が使えない / 読み込みが間に合わない / 動きを減らす設定 の場合は、従来のCSSローダーのまま。 */
(function () {
  "use strict";
  var loader = document.getElementById("loader");
  if (!loader) return;
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  try {
    var probe = document.createElement("canvas");
    if (!(probe.getContext("webgl") || probe.getContext("experimental-webgl"))) return;
  } catch (e) { return; }

  var THREE_URL = "https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js";
  var LOGO_URL = "public/images/ロゴ_987サウナ_白抜き.png";
  var REVEAL_MS = 1200, EXIT_MS = 1800, LAYERS = 16;

  // pending: 3Dの準備中（ローダー側はこれを見て少しだけ終了を待つ）
  var api = { active: false, pending: true, exit: function () { return Promise.resolve(); } };
  window.loader3d = api;

  function loadThree() {
    if (window.THREE) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = THREE_URL; s.async = true; s.crossOrigin = "anonymous";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  var NOISE = [
    "float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}",
    "float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);",
    "return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}",
    "float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p*=2.03;a*=.5;}return v;}"
  ].join("\n");

  var LOGO_VERT = [
    "uniform float uTime,uExit;varying vec2 vUv;",
    "void main(){vUv=uv;vec3 p=position;",
    "float e=uExit*uExit;p.y+=e*.25*(.4+uv.y);p.x+=sin(uv.y*5.+uTime*1.2)*.02*e;",
    "gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.);}"
  ].join("\n");

  var LOGO_FRAG = [
    "uniform sampler2D uTex;uniform float uTime,uReveal,uExit,uDepth;varying vec2 vUv;",
    NOISE,
    "void main(){",
    "  vec2 uv=vUv;",
    "  float hazeAmt=.006+.02*(1.-uReveal)+.05*uExit;",
    "  uv.x+=(fbm(vec2(uv.x*5.,uv.y*3.-uTime*1.3))-.5)*hazeAmt;",
    "  vec4 t=texture2D(uTex,uv);",
    "  if(t.a<.02)discard;",
    "  float n=fbm(uv*5.+7.3);",
    // 下から熱で浮かび上がる
    "  float f1=n*.55+(1.-uv.y)*.45, r=uReveal*1.3-.15;",
    "  float vis=smoothstep(f1-.07,f1+.07,r);",
    "  float edge=smoothstep(.14,0.,abs(f1-r))*step(.001,uReveal)*(1.-smoothstep(.95,1.,uReveal));",
    // 終了時は上から蒸気になって抜けていく
    "  float x=uExit*1.25-(n-.5)*.35-(uv.y-.5)*.2;",
    "  float gone=smoothstep(0.,1.,clamp(x,0.,1.));",
    "  float edge2=0.;",
    "  vis*=1.-gone;",
    "  vec3 kinari=vec3(.961,.941,.902), gold=vec3(.722,.576,.353);",
    "  vec3 col;",
    "  if(uDepth<.001){",
    "    col=kinari;",
    "    float band=uv.x*.8+uv.y*.6-mod(uTime*.22,3.2)+.6;",
    "    col+=smoothstep(.22,0.,abs(band))*vec3(.98,.9,.75)*.28;",
    "  }else{",
    "    col=mix(gold*.95,gold*.28,uDepth);",
    "  }",
    "  float g=clamp(edge+edge2,0.,1.);",
    "  col=mix(col,vec3(.98,.97,.95),g*.8);",
    "  float a=t.a*max(vis,g*.55);",
    "  if(a<.01)discard;",
    "  gl_FragColor=vec4(col,a);",
    "}"
  ].join("\n");

  var PART_VERT = [
    "attribute float aSeed;uniform float uTime,uSpeed,uSize,uPR,uBoost;varying float vAlpha;varying float vSeed;",
    "void main(){",
    "  float life=fract(uTime*uSpeed*(.7+aSeed*.6)+aSeed*17.);",
    "  vec3 p=position;",
    "  p.y+=life*3.4;",
    "  p.x+=sin(life*5.+aSeed*40.)*.3*life;",
    "  vec4 mv=modelViewMatrix*vec4(p,1.);",
    "  gl_Position=projectionMatrix*mv;",
    "  gl_PointSize=uSize*(.45+life)*uPR*(1.+uBoost*.6)/-mv.z;",
    "  vAlpha=sin(life*3.14159)*(1.+uBoost*1.5);vSeed=aSeed;",
    "}"
  ].join("\n");

  var STEAM_FRAG = [
    "uniform float uOpacity;varying float vAlpha;varying float vSeed;",
    NOISE,
    "void main(){vec2 c=gl_PointCoord-.5;float d=length(c);",
    "  float puff=smoothstep(.5,.05,d)*(.55+.45*fbm(gl_PointCoord*3.+vSeed*9.));",
    "  float a=puff*vAlpha*uOpacity;if(a<.003)discard;",
    "  gl_FragColor=vec4(vec3(.96,.93,.88),a);}"
  ].join("\n");

  var EMBER_FRAG = [
    "uniform float uOpacity;varying float vAlpha;varying float vSeed;",
    "void main(){float d=length(gl_PointCoord-.5);",
    "  float a=smoothstep(.5,0.,d);a*=a*vAlpha*uOpacity;if(a<.003)discard;",
    "  gl_FragColor=vec4(mix(vec3(.95,.9,.8),vec3(.8,.88,.95),vSeed)*a,a);}"
  ].join("\n");

  function particles(THREE, count, spreadX, startY, depth, uniforms, frag, blending) {
    var pos = new Float32Array(count * 3), seed = new Float32Array(count);
    for (var i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - .5) * spreadX;
      pos[i * 3 + 1] = startY + Math.random() * .3;
      pos[i * 3 + 2] = (Math.random() - .5) * depth;
      seed[i] = Math.random();
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
    var mat = new THREE.ShaderMaterial({
      uniforms: uniforms, vertexShader: PART_VERT, fragmentShader: frag,
      transparent: true, depthWrite: false, blending: blending
    });
    return new THREE.Points(geo, mat);
  }

  function start(THREE, texture) {
    if (loader.classList.contains("done") || window.__loaderFinished) { api.pending = false; return; }
    var canvas = document.createElement("canvas");
    canvas.className = "loader-canvas";
    canvas.setAttribute("aria-hidden", "true");
    var inner = loader.querySelector(".loader-inner") || loader;
    inner.insertBefore(canvas, inner.firstChild);

    var renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    var pr = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pr);
    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(35, 1, .1, 50);
    camera.position.set(0, .1, 7.2);

    var group = new THREE.Group();
    scene.add(group);

    var aspect = (texture.image.naturalWidth || texture.image.width) / (texture.image.naturalHeight || texture.image.height);
    var h = 2.5, w = h * aspect;
    var plane = new THREE.PlaneGeometry(w, h);
    var shared = { uTime: { value: 0 }, uReveal: { value: 0 }, uExit: { value: 0 }, uTex: { value: texture } };
    var materials = [];
    for (var i = LAYERS - 1; i >= 0; i--) {
      var mat = new THREE.ShaderMaterial({
        uniforms: { uTime: shared.uTime, uReveal: shared.uReveal, uExit: shared.uExit, uTex: shared.uTex, uDepth: { value: i / (LAYERS - 1) } },
        vertexShader: LOGO_VERT, fragmentShader: LOGO_FRAG, transparent: true, depthWrite: false
      });
      var m = new THREE.Mesh(plane, mat);
      m.position.z = -i * .011;
      m.renderOrder = LAYERS - i;
      group.add(m);
      materials.push(mat);
    }

    var partU = { uTime: shared.uTime, uPR: { value: pr * 220 }, uBoost: { value: 0 } };
    var steam = particles(THREE, 70, 2.6, -1.9, 1.6, {
      uTime: partU.uTime, uPR: partU.uPR, uBoost: partU.uBoost,
      uSpeed: { value: .1 }, uSize: { value: 2.3 }, uOpacity: { value: 0 }
    }, STEAM_FRAG, THREE.NormalBlending);
    var embers = particles(THREE, 26, 2.6, -1.8, 1.4, {
      uTime: partU.uTime, uPR: partU.uPR, uBoost: partU.uBoost,
      uSpeed: { value: .09 }, uSize: { value: .07 }, uOpacity: { value: 0 }
    }, EMBER_FRAG, THREE.AdditiveBlending);
    steam.renderOrder = 100; embers.renderOrder = 101;
    scene.add(steam); scene.add(embers);

    function resize() {
      var r = canvas.getBoundingClientRect();
      var cw = Math.max(1, r.width), ch = Math.max(1, r.height);
      renderer.setSize(cw, ch, false);
      camera.aspect = cw / ch;
      camera.updateProjectionMatrix();
    }
    loader.classList.add("is-3d"); // 表示してからサイズを測る
    resize();
    window.addEventListener("resize", resize);

    var pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    function onMove(e) {
      var p = e.touches ? e.touches[0] : e;
      pointer.tx = (p.clientX / window.innerWidth - .5) * 2;
      pointer.ty = (p.clientY / window.innerHeight - .5) * 2;
    }
    window.addEventListener("pointermove", onMove, { passive: true });

    var t0 = performance.now(), exitStart = 0, raf = 0, exitResolve = null;
    function easeOut(x) { return 1 - Math.pow(1 - Math.min(Math.max(x, 0), 1), 3); }

    function frame(now) {
      var t = (now - t0) / 1000;
      shared.uTime.value = t;
      var rv = 1, intro = 1 - easeOut((now - t0) / REVEAL_MS); // ロゴは最初から表示し、動きだけ落ち着かせる
      shared.uReveal.value = rv;
      var ex = exitStart ? Math.min((now - exitStart) / EXIT_MS, 1) : 0;
      shared.uExit.value = ex;
      partU.uBoost.value = ex;
      steam.material.uniforms.uOpacity.value = .15 * Math.min(t / .6, 1) * (1 - ex * .4);
      embers.material.uniforms.uOpacity.value = .7 * Math.min(t / 1.2, 1) * (1 - ex);

      pointer.x += (pointer.tx - pointer.x) * .06;
      pointer.y += (pointer.ty - pointer.y) * .06;
      var breath = Math.sin(t * 1.4) * .5 + .5; // 約4.5秒で一呼吸
      group.rotation.y = -.25 * intro * intro + Math.sin(t * .45) * .16 + pointer.x * .18;
      group.rotation.x = Math.sin(t * .35) * .04 + pointer.y * .1 - .03;
      group.position.y = .05 - intro * .06 + ex * .08;
      var s = (.96 + .04 * (1 - intro)) * (1 + breath * .018) * (1 + ex * .03);
      group.scale.set(s, s, s);

      renderer.render(scene, camera);
      // 背景のフェードを重ねて、ゆっくり溶け合うように
      if (ex >= .75 && exitResolve) { var r = exitResolve; exitResolve = null; r(); }
      raf = requestAnimationFrame(frame);
    }
    raf = requestAnimationFrame(frame);

    function dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onMove);
      plane.dispose(); texture.dispose();
      materials.forEach(function (m) { m.dispose(); });
      [steam, embers].forEach(function (p) { p.geometry.dispose(); p.material.dispose(); });
      renderer.dispose();
      if (renderer.forceContextLoss) renderer.forceContextLoss();
      canvas.remove();
    }

    api.active = true;
    api.pending = false;
    api.exit = function () {
      return new Promise(function (resolve) {
        // 動きが落ち着いてから、ゆっくり霧に溶かす
        var wait = Math.max(0, REVEAL_MS * .8 - (performance.now() - t0));
        setTimeout(function () {
          exitResolve = function () { resolve(); setTimeout(dispose, 900); };
          exitStart = performance.now();
        }, wait);
      });
    };
  }

  // ロゴはページに既にある <img> を流用（同じ画像をもう一度取りに行かない）
  function logoImage() {
    var img = loader.querySelector(".loader-logo");
    return new Promise(function (resolve, reject) {
      if (img && img.complete && img.naturalWidth) return resolve(img);
      if (img) {
        img.addEventListener("load", function () { resolve(img); }, { once: true });
        img.addEventListener("error", reject, { once: true });
        return;
      }
      var el = new Image();
      el.onload = function () { resolve(el); };
      el.onerror = reject;
      el.src = LOGO_URL;
    });
  }

  Promise.all([loadThree(), logoImage()]).then(function (r) {
    var THREE = window.THREE, tex = new THREE.Texture(r[1]);
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    start(THREE, tex);
  }).catch(function () { api.pending = false; /* CSSローダーのまま */ });
})();
