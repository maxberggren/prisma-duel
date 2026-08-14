/* ---------------- emitter housings ----------------
   Small machined-aluminium boxes bolted to the wall, seen very slightly from
   above-left, lit by the same key as the wall and the disc shadow.  The metal
   is deliberately dim -- front face ~0.150 linear, lit chamfer ~0.26, the
   shaded side ~0.036 -- so the hardware never competes with the beams.  The
   only bright thing is the pupil, which sits at the bottom of a bore drilled
   along the beam axis, exactly at the ray origin (0.030 world units ahead of
   the emitter centre).  The housing itself is only *partly* turned with the
   aim, the way a real fixture on an adjustable mount would be, so the boxes
   stay squarely on the wall; the bore is drilled along the true optical axis. */
  {
    vec2  EMB = vec2(0.0290, 0.0250);          // body half-extents, world units
    float EMR = 0.0038;                        // corner radius
    vec2  Lw  = normalize(vec2(-0.60,-0.80));  // toward the key, world, y-down

    for (int i=0;i<8;i++){
      if (i >= uNE) break;
      vec4 E = uEm[i];
      vec2 dw = P - E.xy;
      if (abs(dw.x) > 0.13 || abs(dw.y) > 0.13) continue;

      float ea = E.z*0.30;                     // housing yaw: damped aim
      mat2  Rm = rot(-ea);
      vec2  lp = Rm * dw;                      // housing space, +x roughly the beam
      vec2  L2 = Rm * Lw;                      // key direction, housing space
      vec3  L3 = normalize(vec3(L2*0.95, 0.42));  // grazing enough to separate facets
      vec3  Hh = normalize(L3 + vec3(0.0,0.0,1.0));

      // the optical axis, expressed inside the housing frame
      float ba   = E.z - ea;
      vec2  bdir = vec2(cos(ba), sin(ba));
      vec2  bl   = vec2(dot(lp, bdir), dot(lp, vec2(-bdir.y, bdir.x)));

      float body = sdRound(lp, EMB, EMR);

      /* ---- what the housing throws on the wall: a broad occlusion, a soft
              offset cast shadow and a tight contact line ------------------- */
      float sdB    = sdRound(lp - Rm*vec2(0.0140, 0.0190), EMB, EMR);
      float shWide = 1.0 - smoothstep(-0.014, 0.108, sdB);
      float shSoft = 1.0 - smoothstep(-0.006, 0.036, sdB);
      float shCont = 1.0 - smoothstep(-0.0020, 0.0085,
                       sdRound(lp - Rm*vec2(0.0030,0.0042), EMB, EMR));
      col *= 1.0 - 0.38*shWide - 0.55*shSoft - 0.48*shCont;

      if (body < px*2.0){
        float m = 1.0 - smoothstep(-px, px, body);

        /* ---- outward direction of the silhouette ------------------------ */
        float ee = 0.00055;
        vec2  g  = vec2(sdRound(lp+vec2(ee,0.0), EMB, EMR) - sdRound(lp-vec2(ee,0.0), EMB, EMR),
                        sdRound(lp+vec2(0.0,ee), EMB, EMR) - sdRound(lp-vec2(0.0,ee), EMB, EMR));
        g = normalize(g + vec2(1e-6, 1e-7));

        /* ---- machined chamfer: a FLAT 40 deg facet with two crisp creases,
                widest along the top, where we look down onto the lid ------- */
        float cw   = 0.0022 + 0.0040*max(-g.y, 0.0)
                            + 0.0013*max(-g.x, 0.0)
                            + 0.0005*max( g.y, 0.0);
        float din  = -body;
        float face = smoothstep(cw - px*0.8, cw + px*0.8, din);   // 1 = flat front face
        vec3  nCh  = normalize(vec3(g*0.6428, 0.7660));
        vec3  n    = normalize(mix(nCh, vec3(0.0,0.0,1.0), face));

        // the outermost pixel rolls over to grazing: a deburred edge
        float roll = clamp(1.0 - din/(px*1.8), 0.0, 1.0);
        vec3  nR   = normalize(vec3(g*0.9952, 0.0980));
        n = normalize(mix(n, nR, roll*roll));

        /* ---- brushed aluminium: fine streaks running along the x axis ---- */
        float br  = fbm(vec2(lp.x*44.0, lp.y*1400.0));
        float br2 = vnoise(vec2(lp.x*15.0, lp.y*400.0));

        float ndl = max(dot(n, L3), 0.0);
        float amb = 0.34 + 0.30*n.z + 0.22*max(-n.y, 0.0);

        vec3  alb   = vec3(0.552, 0.572, 0.616);
        vec3  metal = alb * (0.4700*ndl + 0.1180*amb);

        float nh = max(dot(n, Hh), 0.0);
        metal += vec3(0.62,0.65,0.73) * pow(nh,  28.0) * 0.40 * (0.55 + 0.75*br);
        metal += vec3(0.95,0.97,1.06) * pow(nh, 120.0) * 0.30 * (0.50 + 0.80*br);

        // grazing rim: the deburred edge picking up the room, brightest where
        // it faces the key
        float fr = pow(1.0 - n.z, 4.0);
        metal += vec3(0.26,0.275,0.325) * fr
                 * (0.10 + 1.05*max(dot(normalize(n.xy + vec2(1e-6,1e-7)), L2), 0.0));

        // the broad key falls off across the little box: top-left brightest
        metal *= 1.0 - 0.26*smoothstep(-EMB.y, EMB.y, lp.y);
        metal *= 1.0 - 0.10*smoothstep(-EMB.x, EMB.x, lp.x);
        metal *= 0.940 + 0.120*br2;

        /* ---- a countersunk port on the front face (machined detail) ------ */
        vec2  pq  = (lp - vec2(-0.0110, -0.0022)) / vec2(1.0, 0.90);
        float pd  = length(pq) - 0.0058;
        if (pd < px*2.0){
          float pm  = 1.0 - smoothstep(-px, px, pd);
          vec2  pg  = normalize(pq + vec2(1e-6,1e-7));
          float pin = clamp(-pd/0.0026, 0.0, 1.0);
          vec3  prt = mix(vec3(0.062,0.065,0.074), vec3(0.0155,0.0166,0.0205), pin);
          prt += vec3(0.245,0.256,0.285) * max(-dot(pg, L2), 0.0) * (1.0-pin*0.75);
          metal = mix(metal, prt, pm);
          // the lit lip of the countersink, on the key side
          metal += vec3(0.30,0.315,0.355) * smoothstep(px*1.8, 0.0, abs(pd + 0.0009))
                   * (0.10 + 1.0*max(dot(pg, L2), 0.0));
        }

        /* ---- the bore, drilled along the optical axis -------------------- */
        vec2  ap  = bl - vec2(0.0212, 0.0);
        vec2  apH = vec2(0.0106, 0.0075);
        float apd = sdRound(ap, apH, 0.0024);
        if (apd < px*3.0){
          float apm = 1.0 - smoothstep(-px, px, apd);
          float bd  = clamp(-apd/0.0032, 0.0, 1.0);
          vec2  ag  = normalize(ap/apH + vec2(1e-5, 1e-6));
          vec3  bore = mix(vec3(0.0380,0.0402,0.0465), vec3(0.0075,0.0081,0.0105), bd);
          bore += vec3(0.130,0.136,0.152) * max(-dot(ag, L2), 0.0) * (1.0-bd)*(1.0-bd);
          metal = mix(metal, bore, apm);
          // chamfer where the bore mouth breaks the front face
          metal += vec3(0.17,0.179,0.202)
                   * smoothstep(px*1.5, 0.0, abs(apd + 0.0008))
                   * (0.06 + 1.05*max(dot(ag, L2), 0.0));
        }

        /* ---- the emitting pupil, exactly at the ray origin --------------- */
        float pr = length(bl - vec2(0.0300, 0.0));
        metal += vec3(0.30,0.313,0.345) * 0.45 * exp(-pr/0.0105);
        metal  = mix(metal, vec3(0.85,0.86,0.92), smoothstep(0.0038, 0.0021, pr));
        metal += vec3(1.00,0.985,0.955) * 2.2 * exp(-(pr*pr)/(0.0021*0.0021));

        /* The housings were graded to stay out of the beams' way, but measured
           against the reference they came out ~1.6x too dark (body median 0.139
           vs 0.223), which cost all the machining detail. Lift the diffuse
           response without touching the specular structure. */
        metal *= 1.62;

        // hover affordance
        float ol = 1.0 - smoothstep(0.0, px*2.0, abs(body));
        metal += vec3(0.28,0.48,0.85) * ol * uHoverEm.y * 0.85
                 * step(abs(float(i) - uHoverEm.x), 0.5);

        col = mix(col, metal, m);
      }
    }
  }