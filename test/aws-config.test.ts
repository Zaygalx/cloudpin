import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { awsProfilesFromConfig, profilesForAccount, readAwsProfiles } from "../src/aws-config.js";
import { tempDir } from "./tmp.js";

// All account IDs and values here are made up.
const SECRET = "wJalrXUtnFEMI-K7MDENG-bPxRfiCYEXAMPLEKEY";

const FIXTURE = `
# a comment
; another comment
[default]
region = eu-west-1
aws_access_key_id = AKIAEXAMPLEEXAMPLE00
aws_secret_access_key = ${SECRET}

[profile sso-dev]
sso_session = corp
sso_account_id = 111111111111
sso_role_name = Developer

[sso-session corp]
sso_start_url = https://example.awsapps.com/start
sso_region = eu-west-1

[profile prod-admin]
role_arn = arn:aws:iam::222222222222:role/Admin
source_profile = default

[profile gov]
role_arn = arn:aws-us-gov:iam::333333333333:role/Reader
credential_process = /usr/local/bin/helper --secret ${SECRET}

[profile process-only]
credential_process = /usr/local/bin/helper --secret ${SECRET}

[profile static-only]
aws_access_key_id = AKIAEXAMPLEEXAMPLE01
aws_secret_access_key = ${SECRET}

[profile "spaced name"]
sso_account_id = 111111111111

[profile  two words ]
sso_account_id = 111111111111

[profile odd;name$(x)]
SSO_ACCOUNT_ID = 111111111111

[not-a-profile]
sso_account_id = 111111111111

[services dev]
s3 =
  sso_account_id = 111111111111
`;

describe("awsProfilesFromConfig", () => {
  it("keeps only profile names and the account each one names, from sso_account_id or role_arn", () => {
    expect(awsProfilesFromConfig(FIXTURE)).toEqual([
      { name: "default" },
      { name: "sso-dev", account: "111111111111" },
      { name: "prod-admin", account: "222222222222" },
      { name: "gov", account: "333333333333" },
      { name: "process-only" },
      { name: "static-only" },
      { name: "spaced name", account: "111111111111" },
      { name: "odd;name$(x)", account: "111111111111" },
    ]);
  });

  it("never keeps another value from the file, such as a secret key or a credential_process command", () => {
    const out = JSON.stringify(awsProfilesFromConfig(FIXTURE));
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("AKIAEXAMPLE");
    expect(out).not.toContain("helper");
    expect(out).not.toContain("awsapps");
    expect(out).not.toContain("eu-west-1");
  });

  it("ignores values that are not a 12-digit account, and indented (nested) lines", () => {
    const text = "[profile a]\nsso_account_id = 1234 # comment\n[profile b]\nrole_arn = not-an-arn\n[profile c]\n  sso_account_id = 444444444444\n";
    expect(awsProfilesFromConfig(text)).toEqual([{ name: "a" }, { name: "b" }, { name: "c" }]);
  });

  it("merges a profile that appears twice, and treats [profile default] as default", () => {
    const text = "[profile default]\nsso_account_id = 555555555555\n[profile x]\nregion = us-east-1\n[profile x]\nrole_arn = arn:aws:iam::666666666666:role/R\n";
    expect(awsProfilesFromConfig(text)).toEqual([
      { name: "default", account: "555555555555" },
      { name: "x", account: "666666666666" },
    ]);
  });

  it("reads CRLF files and a BOM", () => {
    expect(awsProfilesFromConfig("﻿[profile w]\r\nsso_account_id=777777777777\r\n")).toEqual([
      { name: "w", account: "777777777777" },
    ]);
  });
});

describe("profilesForAccount", () => {
  it("lists the profiles for one account, in file order", () => {
    expect(profilesForAccount(awsProfilesFromConfig(FIXTURE), "111111111111")).toEqual([
      "sso-dev",
      "spaced name",
      "odd;name$(x)",
    ]);
    expect(profilesForAccount(awsProfilesFromConfig(FIXTURE), "999999999999")).toEqual([]);
  });
});

describe("readAwsProfiles", () => {
  it("reads AWS_CONFIG_FILE, and finds no profiles when the file is missing", () => {
    const dir = tempDir("cloudpin-awscfg-");
    const path = join(dir, "config");
    writeFileSync(path, "[profile p]\nsso_account_id = 121212121212\n");
    expect(readAwsProfiles({ AWS_CONFIG_FILE: path })).toEqual({ path, profiles: [{ name: "p", account: "121212121212" }] });
    expect(readAwsProfiles({ AWS_CONFIG_FILE: join(dir, "none") })).toEqual({ path: join(dir, "none"), profiles: [] });
  });

  it("defaults to ~/.aws/config under the command's HOME", () => {
    const dir = tempDir("cloudpin-awshome-");
    expect(readAwsProfiles({ HOME: dir }).path).toBe(join(dir, ".aws", "config"));
  });
});
