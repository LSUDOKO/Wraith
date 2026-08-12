# [2.0.0](https://github.com/LSUDOKO/Wraith/compare/v1.3.1...v2.0.0) (2026-08-12)


* feat(contracts)!: take TEE authority from the registry, not the owner ([6424579](https://github.com/LSUDOKO/Wraith/commit/6424579f03b91d4b41d37a907cac47f3a4b0c298))


### BREAKING CHANGES

* setTeeAddress(address,bool) is removed. Deployments no
longer register a TEE signer; registry registration is the only step.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

## [1.3.1](https://github.com/LSUDOKO/Wraith/compare/v1.3.0...v1.3.1) (2026-08-12)


### Bug Fixes

* **frontend:** allow .ts import extensions so the build type-checks ([7062f33](https://github.com/LSUDOKO/Wraith/commit/7062f330af226bc15ae59963aa88231112621d54))

# [1.3.0](https://github.com/LSUDOKO/Wraith/compare/v1.2.0...v1.3.0) (2026-08-12)


### Features

* **frontend:** production polish — container, stats, network guard, states ([647b8d6](https://github.com/LSUDOKO/Wraith/commit/647b8d65e31c8488ddff72f575f79a514a281575))

# [1.2.0](https://github.com/LSUDOKO/Wraith/compare/v1.1.0...v1.2.0) (2026-08-11)


### Features

* **frontend:** add live FTSO ticker, on-chain activity log and mechanism rail ([48e8c50](https://github.com/LSUDOKO/Wraith/commit/48e8c50c1d83786ef53afef67854581479f764d1))

# [1.1.0](https://github.com/LSUDOKO/Wraith/compare/v1.0.0...v1.1.0) (2026-08-11)


### Features

* **contracts:** add Deploy script and Coston2 deployment runbook ([3285817](https://github.com/LSUDOKO/Wraith/commit/3285817d5ac12679b069012443f0664fd0a27f1f))
* **extension:** add enclave runtime — ABI codecs, FTSO reader, decrypt client, handler ([cbcc34f](https://github.com/LSUDOKO/Wraith/commit/cbcc34f581e433719c4aa5c6792d684ea59fe610))
* **frontend:** add cancel, explorer links and live order refresh ([4a69d7c](https://github.com/LSUDOKO/Wraith/commit/4a69d7ceb0f9d9e3271400c1a690a2c69ba9a959))

# 1.0.0 (2026-08-11)


### Features

* **contracts:** add WraithOrders private conditional order contract ([50ccb32](https://github.com/LSUDOKO/Wraith/commit/50ccb321fe1fcbe61d663842edfa892660e1936f))
* **extension:** add TEE-side trigger evaluator ([2777770](https://github.com/LSUDOKO/Wraith/commit/27777707bc53f513f6cbaa336ba9c6da81c4c7db))
* **frontend:** add order composer that seals conditions client-side ([0227c99](https://github.com/LSUDOKO/Wraith/commit/0227c993ce38d5185bdae1502125c6cc93984946))
* **keeper:** add permissionless tick and relay loop ([67f99c3](https://github.com/LSUDOKO/Wraith/commit/67f99c3b49afab5f5d6e97969fd5771672b08455))
