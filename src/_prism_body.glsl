/* ---------------- disc shadow: soft, offset, with contact darkening -------- */
  {
    vec2  so    = vec2(0.026, 0.040);                       // light from upper-left
    float sdS   = sdDisc(P, PC + so, PR*1.010, PWD, PWH);
    float dNear = sdDisc(P, PC, PR, PWD, PWH);

    // broad penumbra (wide + very soft), squared for a non-linear falloff
    float broad = 1.0 - smoothstep(-0.060, 0.170, sdS);
    broad *= broad;
    // mid penumbra
    float midS  = 1.0 - smoothstep(-0.012, 0.060, sdS);
    // tight contact core just under the disc
    float tight = 1.0 - smoothstep(-0.004, 0.022, sdS);
    // ambient occlusion hugging the silhouette in every direction
    float ao    = 1.0 - smoothstep(0.0, 0.052, dNear);
    ao *= ao;

    float sh = clamp(0.46*broad + 0.28*midS + 0.22*tight + 0.24*ao, 0.0, 0.88);
    col *= mix(vec3(1.0), vec3(0.20, 0.24, 0.36), sh);      // shadows go cool
  }

  /* ---------------- the dichroic disc ---------------- */
  float d    = sdDisc(P, PC, PR, PWD, PWH);
  float mask = 1.0 - smoothstep(-px, px, d);

  if (mask > 0.0015){
    vec2  q  = (P - PC)/PR;        // normalised local, y down
    float r  = length(q);
    float rr = min(r, 1.0);
    float an = atan(q.y, q.x);

    /* ================= 1. the stretched-film coordinate ==================
       Two octaves of very low-frequency warp bend the interference bands
       into long organic sweeps.  Frequencies here are ~1 cycle across the
       whole disc, so nothing can alias.                                   */
    vec2 w1 = vec2(vnoise(q*0.72 + vec2( 3.10, 7.40)),
                   vnoise(q*0.72 + vec2(-5.20, 1.80))) - 0.5;
    vec2 w2 = vec2(vnoise(q*1.45 + vec2(11.00, 2.30)),
                   vnoise(q*1.45 + vec2(-1.50, 9.30))) - 0.5;
    vec2 qw = q + w1*0.56 + w2*0.26;

    // anisotropic frames: the sweeps run long in e2 / f2 and vary across e1 / f1
    vec2 e1 = normalize(vec2( 0.82, -0.57));
    vec2 e2 = vec2(-e1.y, e1.x);
    vec2 f1 = normalize(vec2( 0.35,  0.94));
    vec2 f2 = vec2(-f1.y, f1.x);
    vec2 qa = vec2(dot(qw,e1)*1.75, dot(qw,e2)*0.13);
    vec2 qb = vec2(dot(qw,f1)*1.35, dot(qw,f2)*0.17);

    float s1 = fbm(qa + 2.0);                 // primary broad sweeps
    float s2 = fbm(qb - 4.0);                 // crossing secondary sweeps
    // the mottle is stretched too: nothing on this sheet is round
    float s3 = fbm(vec2(dot(q,f1)*3.4, dot(q,f2)*1.05) + 9.0);

    /* ================= 2. pseudo-3D surface ============================= */
    float dome  = sqrt(max(1e-4, 1.0 - rr*rr*0.62));
    vec2  slope = q*0.52 + w1*0.26 + (vec2(s2,s1)-0.5)*0.14;
    vec3  n = normalize(vec3(slope, dome*1.20));
    vec3  V = normalize(vec3(q*0.17, 2.40));
    vec3  L = normalize(vec3(-0.48, -0.62, 0.66));   // key: upper-left, forward
    float cosT = clamp(dot(n, V), 0.04, 1.0);
    float ndl  = dot(n, L);

    /* ================= 3. luminance field =================================
       Everything about how BRIGHT the body is lives here, and nothing else
       is allowed to touch it.  The body must stay well under the wall so the
       beams read as incandescent: Y sits around 0.012 - 0.09 linear.       */
    float shade = 0.5 + 0.5*ndl;
    float tilt  = 0.5 - 0.5*dot(normalize(q + vec2(1e-4)), normalize(vec2(0.60,0.80)))*rr;
    float lift  = smoothstep(0.04, 0.96, shade*0.45 + tilt*0.55);

    float Y = mix(0.0072, 0.0555, lift);

    // broad sheet band: the soft return a curved film throws back at the key
    float sheetT = dot(q - vec2(-0.10, -0.22), normalize(vec2(0.62, -0.78)));
    float sheet  = exp(-sheetT*sheetT*2.4);
    // broken up by the sweep field, otherwise it reads as an airbrushed smear
    sheet *= 0.62 + 0.76*s1;
    float lit    = 0.30 + 0.70*smoothstep(0.05, 0.90, shade);
    Y += 0.0125*sheet*lit;

    // interference bands are not perfectly flat in value either - but only a
    // gentle ripple, so the structure stays a hue phenomenon
    Y *= 0.90 + 0.22*s1 + 0.10*s2;

    /* Grazing Fresnel, but only where the rim actually faces the key: in the
       reference the edge lights up along the top-left and stays dark, even
       slightly vignetted, everywhere else.                                  */
    float rimFace = 0.5 + 0.5*dot(normalize(q + vec2(1e-5)), normalize(vec2(-0.55,-0.83)));
    Y += 0.036*pow(rr, 7.0)*(0.14 + 0.86*rimFace*rimFace);
    Y *= 1.0 - 0.17*smoothstep(0.72, 1.0, r)*(1.0 - rimFace);

    // multiplicative micro detail: cannot lift the blacks
    // one pixel measured in q units: the finest two octaves fade out before
    // they can ever reach Nyquist, however small the disc is drawn
    float pxq = px/max(PR, 1e-4);
    float micro = vnoise(q*19.0)*0.55
                + vnoise(q*44.0)*0.30*(1.0 - smoothstep(0.40, 0.60, 44.0*pxq));
    float grain = (vnoise(vec2(dot(q,e2)*86.0, dot(q,e1)*23.0)) - 0.5)
                * (1.0 - smoothstep(0.40, 0.60, 86.0*pxq));
    Y *= (0.94 + 0.12*micro) * (1.0 + 0.05*grain);

    // the sheet turns away toward the lower right
    Y *= mix(0.71, 1.10, smoothstep(0.05, 0.92, tilt));

    /* ================= 4. hue / chroma field ==============================
       A thin-film phase field, in radians.  One 2*PI of phase is one fringe
       order.  Coefficients are chosen for ~3 orders across the disc, i.e.
       bands hundreds of pixels wide: broad sweeps, never stripes.          */
    float ph = 7.8*dot(qw, e1)                        // wedge-shaped film ramp
             + 3.5*dot(qw, f1)                        // second, weaker ramp
             + 4.5*(s1 - 0.5)*2.0                     // warped primary sweeps
             + 2.6*(s2 - 0.5)*2.0                     // crossing sweeps
             + 1.3*(s3 - 0.5)*2.0                     // large mottle
             + 4.2*pow(rr, 4.5)                       // film thins at the rim
             // creases: the sheet is tensioned on a round frame, so a few soft
             // folds run out from the middle and bend every band as they go
             + 1.15*sin(atan(qw.y, qw.x)*2.0 + 1.7)*smoothstep(0.04, 0.60, r)
             // the film crowds against the frame: a few tight orders hug every
             // polished edge, arc and cut face alike
             + 3.0*exp(-(max(0.0,-d)/PR)*7.0)
             + 0.35*(vnoise(vec2(dot(q,e1)*21.0, dot(q,e2)*8.0)) - 0.5);

    float fr = sin(ph);                               // -1 teal .. +1 violet
    // shaped so the hue rests near royal blue and only the fringe peaks make
    // the long excursions out to teal and violet
    float frs = 0.34*fr + 0.66*fr*fr*fr;
    // the teal side of the swing is held shorter: too much of it and the body
    // turns slate-green instead of reading as a blue dichroic
    frs *= (frs < 0.0) ? 0.74 : 1.0;
    // faint higher orders: the silky sub-fringes a real film shows between
    // its broad sweeps.  Both are far coarser than a pixel.
    frs += 0.105*sin(ph*2.7 + 2.0) + 0.055*sin(ph*4.3 - 0.6);

    /* The fringe order also drifts slowly across the sheet: the upper-left
       runs blue-teal, the lower-right crowds into indigo and violet.        */
    float drift = dot(q, normalize(vec2(0.55, 0.84)));       // -1 .. +1

    /* ---- position along the dichroic arc, in palette-stop units ---- */
    float u = 2.45
            + 2.45*frs
            + 0.45*sin(2.0*ph + 1.30)
            + 0.80*drift
            + 0.75*smoothstep(0.58, 1.00, r)          // violet crowds the rim
            - 0.20*sheet;                             // sheet band leans teal
    u = clamp(u, 0.0, 5.6);

    /* ---- the palette, sampled straight off the reference ----------------
       Seven stops across teal -> azure -> royal blue -> indigo -> violet ->
       magenta.  Each stop is the reference's own median chroma for that hue,
       scaled by that hue's own median brightness relative to royal blue - so
       the cyan orders come in bright and the indigo troughs come in dark,
       exactly as a real reflectance curve does.  The weighted mean gain over
       the whole disc is ~1, so none of this changes the exposure.          */
    vec3 K0 = vec3(0.10, 2.19, 3.80);   // 195  teal      (x1.90)
    vec3 K1 = vec3(0.13, 1.75, 5.88);   // 212  azure     (x1.70)
    vec3 K2 = vec3(0.26, 0.77, 5.50);   // 228  royal     (x1.00)
    vec3 K3 = vec3(0.41, 0.41, 4.16);   // 243  indigo    (x0.68)
    vec3 K4 = vec3(1.41, 0.70, 4.82);   // 258  violet    (x1.15)
    vec3 K5 = vec3(3.06, 0.41, 7.02);   // 272  purple    (x1.45)
    vec3 K6 = vec3(4.13, 0.24, 6.21);   // 288  magenta   (x1.50)
    vec3 pal = mix(K0, K1, clamp(u,       0.0, 1.0));
    pal = mix(pal, K2, clamp(u - 1.0, 0.0, 1.0));
    pal = mix(pal, K3, clamp(u - 2.0, 0.0, 1.0));
    pal = mix(pal, K4, clamp(u - 3.0, 0.0, 1.0));
    pal = mix(pal, K5, clamp(u - 4.0, 0.0, 1.0));
    pal = mix(pal, K6, clamp(u - 5.0, 0.0, 1.0));

    vec3 base = Y * pal;

    // where the film returns a broad white sheet it desaturates a little
    base = mix(base, vec3(dot(base, vec3(0.2126,0.7152,0.0722)))*vec3(0.72,0.96,1.55),
               0.075*sheet*lit);

    /* ================= 5. light on top of the material ==================== */
    vec3  H = normalize(L + V);
    float ndh = max(dot(n, H), 0.0);
    base += vec3(0.020, 0.045, 0.140) * pow(ndh,  6.0) * 0.16;
    base += vec3(0.090, 0.170, 0.420) * pow(ndh, 34.0) * 0.26;

    /* ---- polished edges: bright thin line, oriented to the key light ---- */
    float ee = px*1.4;
    vec2  gN = vec2(
      sdDisc(P + vec2(ee,0.0), PC, PR, PWD, PWH)
    - sdDisc(P - vec2(ee,0.0), PC, PR, PWD, PWH),
      sdDisc(P + vec2(0.0,ee), PC, PR, PWD, PWH)
    - sdDisc(P - vec2(0.0,ee), PC, PR, PWD, PWH));
    gN = normalize(gN + vec2(1e-7, 1e-7));
    vec2  kl  = normalize(vec2(-0.52, -0.85));      // key light, screen space
    float fac = max(dot(gN, kl), 0.0);

    float din  = max(0.0, -d);
    float band = exp(-din/(px*1.15));
    float core = exp(-din/(px*0.50));
    vec3 edgeC = vec3(0.30, 0.48, 0.95);
    base += edgeC * band * (0.060 + 0.80*pow(fac, 1.4));
    base += vec3(0.85, 0.92, 1.05) * core * 1.35 * pow(fac, 2.6);

    // thin bevel shade just inboard of the highlight -> reads as real thickness
    float bev = smoothstep(px*1.0, px*2.4, din) * (1.0 - smoothstep(px*2.4, px*5.0, din));
    base *= 1.0 - 0.30*bev;

    // hover affordance
    base += vec3(0.28, 0.44, 0.72) * band * uHover * 0.50;

    col = mix(col, base, mask);
  }