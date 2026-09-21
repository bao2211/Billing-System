const fs = require('fs');
const path = require('path');

const PROFILES_DIR = path.resolve(__dirname, '..', 'profiles');
const DEFAULT_PROFILE_PATH = path.join(PROFILES_DIR, 'default.json');

function ensureProfilesDir() {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

function ensureDefaultProfile() {
  ensureProfilesDir();
  if (!fs.existsSync(DEFAULT_PROFILE_PATH)) {
    const fallback = {
      name: 'default',
      spreadsheet_id: '',
      sheet_name: '',
      sheet_range: 'A1:ZZ',
      header_row_index: 1,
      data_start_row_index: 2,
      template_presentation_id: '',
      destination_folder_id: null,
      copy_name_template: '{profile_name}_{sheet_name}_row_{sheet_row}',
      output_format: 'both',
      output_dir: './generated_slide_exports',
      create_run_output_folder: true,
      run_folder_name_template: '{date}_{profile_name}',
      output_file_name_template: '{date}_{row_slug}',
      split_outputs_by_row: false,
      delete_generated_slides_after_export: false,
      skip_export_if_zero_or_empty: false,
      skip_zero_or_empty_column: '',
      export_selected_rows_only: false,
      selected_sheet_rows: [],
      credentials_file: null,
      token_file: './sheet_slide_export_token.json',
      placeholder_strategy: 'mapping_with_fallback',
      placeholder_prefix: '{{',
      placeholder_suffix: '}}',
      placeholder_mapping: {},
      reference_strategy: 'identity',
      reference_mapping: {},
      max_rows: null
    };
    fs.writeFileSync(DEFAULT_PROFILE_PATH, JSON.stringify(fallback, null, 2), 'utf-8');
  }
}

function listProfiles() {
  ensureDefaultProfile();
  return fs
    .readdirSync(PROFILES_DIR)
    .filter((name) => name.toLowerCase().endsWith('.json'))
    .map((name) => path.basename(name, '.json'))
    .sort();
}

const INVALID_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

// Reject names that could escape the profiles directory (path traversal) or that
// name a reserved file. Vietnamese names, spaces and digits stay allowed.
function assertSafeProfileName(name) {
  const value = String(name == null ? '' : name).trim();
  if (!value) throw new Error('Profile name is required.');
  if (value !== path.basename(value) || value === '.' || value === '..' ||
      value.startsWith('.') || INVALID_NAME_CHARS.test(value)) {
    throw new Error(`Invalid profile name: ${name}`);
  }
  return value;
}

function loadProfile(name) {
  ensureDefaultProfile();
  const safeName = assertSafeProfileName(name);
  const profilePath = path.join(PROFILES_DIR, `${safeName}.json`);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`Profile not found: ${name}`);
  }
  return JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
}

function saveProfile(profile) {
  ensureDefaultProfile();
  if (!profile || !String(profile.name || '').trim()) {
    throw new Error('Profile name is required.');
  }
  const safeName = assertSafeProfileName(profile.name);
  profile.name = safeName;
  const profilePath = path.join(PROFILES_DIR, `${safeName}.json`);
  fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf-8');
  return profilePath;
}

function deleteProfile(name) {
  ensureDefaultProfile();
  const safeName = assertSafeProfileName(name);
  if (safeName === 'default') {
    throw new Error('Cannot delete the default profile.');
  }
  const profilePath = path.join(PROFILES_DIR, `${safeName}.json`);
  if (!fs.existsSync(profilePath)) {
    throw new Error('Profile not found.');
  }
  fs.unlinkSync(profilePath);
  return safeName;
}

module.exports = {
  ensureDefaultProfile,
  listProfiles,
  loadProfile,
  saveProfile,
  deleteProfile,
  assertSafeProfileName,
  PROFILES_DIR
};
