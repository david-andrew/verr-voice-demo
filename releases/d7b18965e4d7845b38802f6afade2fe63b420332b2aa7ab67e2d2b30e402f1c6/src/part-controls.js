// Section sound inherits global direction unless a section preset is selected.
// The preset's default for the part's voice type (e.g. boy trebles) applies
// before the section's own adjustments. All sections share the performance's room.
// Masculine/feminine; mirrors verr_voice.synth.presets (VV-SECTION-PRESETS).
// Stored relative to the part's typical voice (0.5); shown on a fixed scale
// (0.25 typical male, 0.75 typical female); stored range widened to -1..2.
export const SEX_RANGE = [-1, 2];
const TYPICAL_SEX = { soprano: .75, alto: .75, tenor: .25, bass: .25 };
export const typicalSex = voice => TYPICAL_SEX[voice] ?? .75;
export const sexScaleValue = (stored, voice) => Math.max(0, Math.min(1, typicalSex(voice) + (stored - .5) / 2));
export const storedSex = (value, voice) => .5 + 2 * (value - typicalSex(voice));
export function sexWeight(age) { const x = Math.max(0, Math.min(1, (age - .05) / .25)); return .3 + .7 * x * x * (3 - 2 * x); }
export const sexShift = c => ((c.vocal_character ?? .5) - .5) * sexWeight(c.age ?? .45);
export const clampControl = (key, value) => key === 'vocal_character' ? Math.max(SEX_RANGE[0], Math.min(SEX_RANGE[1], value)) : Math.max(0, Math.min(1, value));
export function sectionDefaults(controls, preset, voice) {
  const values = preset?.sections?.[voice]?.controls || {};
  const result = {...controls};
  // Same arithmetic as presets.apply_section_defaults: keep the section's
  // difference from the ensemble when the ensemble itself is edited.
  for (const [key, value] of Object.entries(values)) result[key] = clampControl(key, value + (controls[key] - preset.controls[key]));
  return result;
}
export function partControls(global, settings, presets, id, voice, presetId = global.preset_id) {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Error('Part settings must be an object');
  const setting = settings[id] || {};
  if (typeof setting !== 'object' || Array.isArray(setting)) throw Error('Each part setting must be an object');
  const preset = setting.ensemble_preset && presets.find(p => p.id === setting.ensemble_preset);
  if (setting.ensemble_preset && !preset) throw Error('Unknown part ensemble preset');
  const source = preset || presets.find(p => p.id === presetId);
  const result = {...sectionDefaults(preset ? preset.controls : global, source, voice), space: global.space};
  const values = setting.controls || {};
  if (typeof values !== 'object' || Array.isArray(values)) throw Error('Part controls must be an object');
  for (const [key, value] of Object.entries(values)) {
    if (!(key in result) || ['space','preset_id'].includes(key)) throw Error(`Unknown part control: ${key}`);
    if (typeof value !== 'number' || !Number.isFinite(value)) throw Error(`${key} must be finite`);
    result[key] = key === 'size' ? Math.max(1,Math.min(64,Math.round(value))) : clampControl(key, value);
  }
  return result;
}
