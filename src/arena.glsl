/* ---------------- gallery wall ----------------
   Charcoal plaster with a faint blue cast, lit by one broad soft key that sits
   above and slightly left of the frame.  Levels are authored in linear HDR so
   that after the optical vignette, the shoulder, the ACES RRT+ODT and the
   shadow grade the wall lands on the reference: ~0.25 linear under the key,
   ~0.075 across the middle, ~0.015 in the far corners.

   The gradient is driven from uv / aspect (frame space) so the key stays
   centred on the picture at any aspect ratio; P is used only for surface
   texture, which belongs to the wall rather than to the frame.               */

  // gl_FragCoord is y-up; flip so sv.y == 0 is the top of frame
  vec2 sv = vec2(uv.x, 1.0 - uv.y);

  // --- the key: a big soft box well above the top of frame, a touch left
  vec2  kq  = vec2((sv.x - 0.465)*aspect*1.957, (sv.y + 0.370)*1.882);
  float key = exp(-dot(kq,kq));

  // --- ambient wash bouncing round the room: wide, mostly vertical, left-biased
  vec2  wq  = vec2((sv.x - 0.205)*aspect*0.457, (sv.y - 0.228)*1.273);
  float wrp = exp(-dot(wq,wq));

  vec3 wall = vec3(0.29060, 0.35190, 0.49160) * key
            + vec3(0.05710, 0.05970, 0.06910) * wrp
            + vec3(0.01300, 0.00670, 0.00140);

  // --- long, very smooth roll-off into the corners of the room
  float rr = length(vec2((sv.x - 0.476)*aspect, sv.y - 0.521)) * 0.750;
  wall *= 1.0 - 0.768*smoothstep(0.399, 1.067, rr);

  /* --- plaster tooth ------------------------------------------------------
     Purely multiplicative, so the deep corners keep their density instead of
     picking up a noise floor.  Every term is kept below ~0.4 cycles/pixel at
     the default view (one world unit is uH pixels, so vnoise(P*k) runs at
     k/uH cycles per pixel) and the finest one is faded out with fwidth as it
     approaches Nyquist -- no moire, no woven cross-hatch, just surface.      */
  float fw   = fwidth(P.x);                     // world units per pixel
  float band = 1.0 - smoothstep(0.0018, 0.0042, fw);   // fades the fine tooth

  float m1 = fbm(P *   7.0);                    // broad trowel mottle
  float m2 = fbm(P *  25.0);                    // medium plaster relief
  float m3 = vnoise(P * 150.0);                 // tooth
  float m4 = vnoise(P * 320.0 + 41.3);          // fine tooth, band-limited

  wall *= 1.0 + (m1 - 0.5)*0.052
              + (m2 - 0.5)*0.046
              + (m3 - 0.5)*0.038
              + (m4 - 0.5)*0.034*band;

  vec3 col = max(wall, 0.0);

  /* ---------------- arena bounds: the mirrored walls ---------------------
     Beams bank off these, so the boundary has to be legible or a reflection
     looks like it came from nowhere. Outside the box the floor falls away. */
  {
    vec2 hb = uArena * 0.5;
    vec2 q  = abs(P - hb) - hb;
    float dBox = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);   // <0 inside

    col *= mix(0.14, 1.0, smoothstep(0.020, -0.002, dBox));       // outside darkens
    float inner = exp(-max(0.0, -dBox) * 34.0);                   // sheen on the inside face
    float edge  = 1.0 - smoothstep(0.0, px * 2.0, abs(dBox));
    col += vec3(0.26, 0.46, 0.78) * inner * 0.055;
    col += vec3(0.55, 0.74, 1.00) * edge * 0.42;
  }