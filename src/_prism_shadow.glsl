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