"use strict";
const {scenario}=require('./harness.cjs');
const {accessible}=require('./stress-helpers.cjs');
scenario({
  name:'zoomed refresh retains an accessible name', timeout:30,
  setup(f) {f.repository('projects/repo').worktree('merged');f.preferences();},
  launches:[async t=>{await t.settled(); await t.painted();await t.resize(850,560);await t.zoom(1.5);await accessible(t);}],
});
