// SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { enumDesc, fileDesc, messageDesc } from "@bufbuild/protobuf/codegenv2";
import { file_google_protobuf_duration, file_google_protobuf_struct } from "@bufbuild/protobuf/wkt";
/**
 * Describes the file sandbox.proto.
 */
export const file_sandbox = /*@__PURE__*/ fileDesc("Cg1zYW5kYm94LnByb3RvEhRvcGVuc2hlbGwuc2FuZGJveC52MSLDBAoNU2FuZGJveFBvbGljeRIPCgd2ZXJzaW9uGAEgASgNEjoKCmZpbGVzeXN0ZW0YAiABKAsyJi5vcGVuc2hlbGwuc2FuZGJveC52MS5GaWxlc3lzdGVtUG9saWN5EjYKCGxhbmRsb2NrGAMgASgLMiQub3BlbnNoZWxsLnNhbmRib3gudjEuTGFuZGxvY2tQb2xpY3kSNAoHcHJvY2VzcxgEIAEoCzIjLm9wZW5zaGVsbC5zYW5kYm94LnYxLlByb2Nlc3NQb2xpY3kSUgoQbmV0d29ya19wb2xpY2llcxgFIAMoCzI4Lm9wZW5zaGVsbC5zYW5kYm94LnYxLlNhbmRib3hQb2xpY3kuTmV0d29ya1BvbGljaWVzRW50cnkSWAoTbmV0d29ya19taWRkbGV3YXJlcxgGIAMoCzI7Lm9wZW5zaGVsbC5zYW5kYm94LnYxLlNhbmRib3hQb2xpY3kuTmV0d29ya01pZGRsZXdhcmVzRW50cnkaXwoUTmV0d29ya1BvbGljaWVzRW50cnkSCwoDa2V5GAEgASgJEjYKBXZhbHVlGAIgASgLMicub3BlbnNoZWxsLnNhbmRib3gudjEuTmV0d29ya1BvbGljeVJ1bGU6AjgBGmgKF05ldHdvcmtNaWRkbGV3YXJlc0VudHJ5EgsKA2tleRgBIAEoCRI8CgV2YWx1ZRgCIAEoCzItLm9wZW5zaGVsbC5zYW5kYm94LnYxLk5ldHdvcmtNaWRkbGV3YXJlQ29uZmlnOgI4ASJSChBGaWxlc3lzdGVtUG9saWN5EhcKD2luY2x1ZGVfd29ya2RpchgBIAEoCBIRCglyZWFkX29ubHkYAiADKAkSEgoKcmVhZF93cml0ZRgDIAMoCSInCg5MYW5kbG9ja1BvbGljeRIVCg1jb21wYXRpYmlsaXR5GAEgASgJIjoKDVByb2Nlc3NQb2xpY3kSEwoLcnVuX2FzX3VzZXIYASABKAkSFAoMcnVuX2FzX2dyb3VwGAIgASgJIpIBChFOZXR3b3JrUG9saWN5UnVsZRIMCgRuYW1lGAEgASgJEjgKCWVuZHBvaW50cxgCIAMoCzIlLm9wZW5zaGVsbC5zYW5kYm94LnYxLk5ldHdvcmtFbmRwb2ludBI1CghiaW5hcmllcxgDIAMoCzIjLm9wZW5zaGVsbC5zYW5kYm94LnYxLk5ldHdvcmtCaW5hcnkiygEKF05ldHdvcmtNaWRkbGV3YXJlQ29uZmlnEgwKBG5hbWUYASABKAkSEgoKbWlkZGxld2FyZRgCIAEoCRInCgZjb25maWcYAyABKAsyFy5nb29nbGUucHJvdG9idWYuU3RydWN0EhAKCG9uX2Vycm9yGAQgASgJEkMKCWVuZHBvaW50cxgFIAEoCzIwLm9wZW5zaGVsbC5zYW5kYm94LnYxLk1pZGRsZXdhcmVFbmRwb2ludFNlbGVjdG9yEg0KBW9yZGVyGAYgASgFIj4KGk1pZGRsZXdhcmVFbmRwb2ludFNlbGVjdG9yEg8KB2luY2x1ZGUYASADKAkSDwoHZXhjbHVkZRgCIAMoCSIsChhOZXR3b3JrQ3JlZGVudGlhbEJpbmRpbmcSEAoIcHJvdmlkZXIYASABKAkixQcKD05ldHdvcmtFbmRwb2ludBIMCgRob3N0GAEgASgJEgwKBHBvcnQYAiABKA0SEAoIcHJvdG9jb2wYAyABKAkSCwoDdGxzGAQgASgJEhMKC2VuZm9yY2VtZW50GAUgASgJEg4KBmFjY2VzcxgGIAEoCRIrCgVydWxlcxgHIAMoCzIcLm9wZW5zaGVsbC5zYW5kYm94LnYxLkw3UnVsZRITCgthbGxvd2VkX2lwcxgIIAMoCRINCgVwb3J0cxgJIAMoDRI0CgpkZW55X3J1bGVzGAogAygLMiAub3BlbnNoZWxsLnNhbmRib3gudjEuTDdEZW55UnVsZRIbChNhbGxvd19lbmNvZGVkX3NsYXNoGAsgASgIEhkKEXBlcnNpc3RlZF9xdWVyaWVzGAwgASgJEmUKGWdyYXBocWxfcGVyc2lzdGVkX3F1ZXJpZXMYDSADKAsyQi5vcGVuc2hlbGwuc2FuZGJveC52MS5OZXR3b3JrRW5kcG9pbnQuR3JhcGhxbFBlcnNpc3RlZFF1ZXJpZXNFbnRyeRIeChZncmFwaHFsX21heF9ib2R5X2J5dGVzGA4gASgNEgwKBHBhdGgYDyABKAkSJAocd2Vic29ja2V0X2NyZWRlbnRpYWxfcmV3cml0ZRgQIAEoCBInCh9yZXF1ZXN0X2JvZHlfY3JlZGVudGlhbF9yZXdyaXRlGBEgASgIEhgKEGFkdmlzb3JfcHJvcG9zZWQYEiABKAgSGgoSY3JlZGVudGlhbF9zaWduaW5nGBMgASgJEhcKD3NpZ25pbmdfc2VydmljZRgUIAEoCRIWCg5zaWduaW5nX3JlZ2lvbhgVIAEoCRIfChdqc29uX3JwY19tYXhfYm9keV9ieXRlcxgWIAEoDRItCgNtY3AYFyABKAsyIC5vcGVuc2hlbGwuc2FuZGJveC52MS5NY3BPcHRpb25zEkoKEmNyZWRlbnRpYWxfYmluZGluZxgYIAEoCzIuLm9wZW5zaGVsbC5zYW5kYm94LnYxLk5ldHdvcmtDcmVkZW50aWFsQmluZGluZxIlCh1hbGxvd191bmluc3BlY3RlZF9jcmVkZW50aWFscxgZIAEoCBIdChVwcm92aWRlcl9jcmVkZW50aWFsZWQYGiABKAgaZgocR3JhcGhxbFBlcnNpc3RlZFF1ZXJpZXNFbnRyeRILCgNrZXkYASABKAkSNQoFdmFsdWUYAiABKAsyJi5vcGVuc2hlbGwuc2FuZGJveC52MS5HcmFwaHFsT3BlcmF0aW9uOgI4ASKeAQoKTWNwT3B0aW9ucxIeChFzdHJpY3RfdG9vbF9uYW1lcxgBIAEoCEgAiAEBEigKG2FsbG93X2FsbF9rbm93bl9tY3BfbWV0aG9kcxgCIAEoCEgBiAEBEhAKCHZlcnNpb25zGAMgAygJQhQKEl9zdHJpY3RfdG9vbF9uYW1lc0IeChxfYWxsb3dfYWxsX2tub3duX21jcF9tZXRob2RzIlIKEEdyYXBocWxPcGVyYXRpb24SFgoOb3BlcmF0aW9uX3R5cGUYASABKAkSFgoOb3BlcmF0aW9uX25hbWUYAiABKAkSDgoGZmllbGRzGAMgAygJIqQDCgpMN0RlbnlSdWxlEg4KBm1ldGhvZBgBIAEoCRIMCgRwYXRoGAIgASgJEg8KB2NvbW1hbmQYAyABKAkSOgoFcXVlcnkYBCADKAsyKy5vcGVuc2hlbGwuc2FuZGJveC52MS5MN0RlbnlSdWxlLlF1ZXJ5RW50cnkSFgoOb3BlcmF0aW9uX3R5cGUYBSABKAkSFgoOb3BlcmF0aW9uX25hbWUYBiABKAkSDgoGZmllbGRzGAcgAygJEjwKBnBhcmFtcxgJIAMoCzIsLm9wZW5zaGVsbC5zYW5kYm94LnYxLkw3RGVueVJ1bGUuUGFyYW1zRW50cnkaUgoKUXVlcnlFbnRyeRILCgNrZXkYASABKAkSMwoFdmFsdWUYAiABKAsyJC5vcGVuc2hlbGwuc2FuZGJveC52MS5MN1F1ZXJ5TWF0Y2hlcjoCOAEaUwoLUGFyYW1zRW50cnkSCwoDa2V5GAEgASgJEjMKBXZhbHVlGAIgASgLMiQub3BlbnNoZWxsLnNhbmRib3gudjEuTDdRdWVyeU1hdGNoZXI6AjgBSgQICBAJIjYKBkw3UnVsZRIsCgVhbGxvdxgBIAEoCzIdLm9wZW5zaGVsbC5zYW5kYm94LnYxLkw3QWxsb3cimwMKB0w3QWxsb3cSDgoGbWV0aG9kGAEgASgJEgwKBHBhdGgYAiABKAkSDwoHY29tbWFuZBgDIAEoCRI3CgVxdWVyeRgEIAMoCzIoLm9wZW5zaGVsbC5zYW5kYm94LnYxLkw3QWxsb3cuUXVlcnlFbnRyeRIWCg5vcGVyYXRpb25fdHlwZRgFIAEoCRIWCg5vcGVyYXRpb25fbmFtZRgGIAEoCRIOCgZmaWVsZHMYByADKAkSOQoGcGFyYW1zGAkgAygLMikub3BlbnNoZWxsLnNhbmRib3gudjEuTDdBbGxvdy5QYXJhbXNFbnRyeRpSCgpRdWVyeUVudHJ5EgsKA2tleRgBIAEoCRIzCgV2YWx1ZRgCIAEoCzIkLm9wZW5zaGVsbC5zYW5kYm94LnYxLkw3UXVlcnlNYXRjaGVyOgI4ARpTCgtQYXJhbXNFbnRyeRILCgNrZXkYASABKAkSMwoFdmFsdWUYAiABKAsyJC5vcGVuc2hlbGwuc2FuZGJveC52MS5MN1F1ZXJ5TWF0Y2hlcjoCOAFKBAgIEAkiKwoOTDdRdWVyeU1hdGNoZXISDAoEZ2xvYhgBIAEoCRILCgNhbnkYAiADKAkiLAoNTmV0d29ya0JpbmFyeRIMCgRwYXRoGAEgASgJSgQIAhADUgdoYXJuZXNzIi0KF0dldFNhbmRib3hDb25maWdSZXF1ZXN0EhIKCnNhbmRib3hfaWQYASABKAkiGQoXR2V0R2F0ZXdheUNvbmZpZ1JlcXVlc3Qi2gEKGEdldEdhdGV3YXlDb25maWdSZXNwb25zZRJOCghzZXR0aW5ncxgBIAMoCzI8Lm9wZW5zaGVsbC5zYW5kYm94LnYxLkdldEdhdGV3YXlDb25maWdSZXNwb25zZS5TZXR0aW5nc0VudHJ5EhkKEXNldHRpbmdzX3JldmlzaW9uGAIgASgEGlMKDVNldHRpbmdzRW50cnkSCwoDa2V5GAEgASgJEjEKBXZhbHVlGAIgASgLMiIub3BlbnNoZWxsLnNhbmRib3gudjEuU2V0dGluZ1ZhbHVlOgI4ASJxCgxTZXR0aW5nVmFsdWUSFgoMc3RyaW5nX3ZhbHVlGAEgASgJSAASFAoKYm9vbF92YWx1ZRgCIAEoCEgAEhMKCWludF92YWx1ZRgDIAEoA0gAEhUKC2J5dGVzX3ZhbHVlGAQgASgMSABCBwoFdmFsdWUieAoQRWZmZWN0aXZlU2V0dGluZxIxCgV2YWx1ZRgBIAEoCzIiLm9wZW5zaGVsbC5zYW5kYm94LnYxLlNldHRpbmdWYWx1ZRIxCgVzY29wZRgCIAEoDjIiLm9wZW5zaGVsbC5zYW5kYm94LnYxLlNldHRpbmdTY29wZSLwBAoYR2V0U2FuZGJveENvbmZpZ1Jlc3BvbnNlEjMKBnBvbGljeRgBIAEoCzIjLm9wZW5zaGVsbC5zYW5kYm94LnYxLlNhbmRib3hQb2xpY3kSDwoHdmVyc2lvbhgCIAEoDRITCgtwb2xpY3lfaGFzaBgDIAEoCRJOCghzZXR0aW5ncxgEIAMoCzI8Lm9wZW5zaGVsbC5zYW5kYm94LnYxLkdldFNhbmRib3hDb25maWdSZXNwb25zZS5TZXR0aW5nc0VudHJ5EhcKD2NvbmZpZ19yZXZpc2lvbhgFIAEoBBI5Cg1wb2xpY3lfc291cmNlGAYgASgOMiIub3BlbnNoZWxsLnNhbmRib3gudjEuUG9saWN5U291cmNlEh0KFWdsb2JhbF9wb2xpY3lfdmVyc2lvbhgHIAEoDRIdChVwcm92aWRlcl9lbnZfcmV2aXNpb24YCCABKAQSWQoec3VwZXJ2aXNvcl9taWRkbGV3YXJlX3NlcnZpY2VzGAkgAygLMjEub3BlbnNoZWxsLnNhbmRib3gudjEuU3VwZXJ2aXNvck1pZGRsZXdhcmVTZXJ2aWNlEhEKCXdvcmtzcGFjZRgKIAEoCRImCh5wb2xpY3lfdmFsaWRhdGlvbl9mYWlsdXJlX21vZGUYCyABKAkSKAogZXh0ZW5zaW9uX2F1dGhlbnRpY2F0aW9uX2VuYWJsZWQYDCABKAgaVwoNU2V0dGluZ3NFbnRyeRILCgNrZXkYASABKAkSNQoFdmFsdWUYAiABKAsyJi5vcGVuc2hlbGwuc2FuZGJveC52MS5FZmZlY3RpdmVTZXR0aW5nOgI4ASLtAQobU3VwZXJ2aXNvck1pZGRsZXdhcmVTZXJ2aWNlEgwKBG5hbWUYASABKAkSFQoNZ3JwY19lbmRwb2ludBgCIAEoCRIZChFtYXhfcGF5bG9hZF9ieXRlcxgDIAEoBBIyCg9yZXF1ZXN0X3RpbWVvdXQYaCABKAsyGS5nb29nbGUucHJvdG9idWYuRHVyYXRpb24SFwoPdGxzX2NhX2NlcnRfcGVtGAUgASgMEhAKCGF1ZGllbmNlGAYgASgJEiAKGGFsbG93X2luc2VjdXJlX3RyYW5zcG9ydBgHIAEoCEoECAQQBVIHdGltZW91dCpiCgxTZXR0aW5nU2NvcGUSHQoZU0VUVElOR19TQ09QRV9VTlNQRUNJRklFRBAAEhkKFVNFVFRJTkdfU0NPUEVfU0FOREJPWBABEhgKFFNFVFRJTkdfU0NPUEVfR0xPQkFMEAIqYgoMUG9saWN5U291cmNlEh0KGVBPTElDWV9TT1VSQ0VfVU5TUEVDSUZJRUQQABIZChVQT0xJQ1lfU09VUkNFX1NBTkRCT1gQARIYChRQT0xJQ1lfU09VUkNFX0dMT0JBTBACYgZwcm90bzM", [file_google_protobuf_struct, file_google_protobuf_duration]);
/**
 * Describes the message openshell.sandbox.v1.SandboxPolicy.
 * Use `create(SandboxPolicySchema)` to create a new message.
 */
export const SandboxPolicySchema = /*@__PURE__*/ messageDesc(file_sandbox, 0);
/**
 * Describes the message openshell.sandbox.v1.FilesystemPolicy.
 * Use `create(FilesystemPolicySchema)` to create a new message.
 */
export const FilesystemPolicySchema = /*@__PURE__*/ messageDesc(file_sandbox, 1);
/**
 * Describes the message openshell.sandbox.v1.LandlockPolicy.
 * Use `create(LandlockPolicySchema)` to create a new message.
 */
export const LandlockPolicySchema = /*@__PURE__*/ messageDesc(file_sandbox, 2);
/**
 * Describes the message openshell.sandbox.v1.ProcessPolicy.
 * Use `create(ProcessPolicySchema)` to create a new message.
 */
export const ProcessPolicySchema = /*@__PURE__*/ messageDesc(file_sandbox, 3);
/**
 * Describes the message openshell.sandbox.v1.NetworkPolicyRule.
 * Use `create(NetworkPolicyRuleSchema)` to create a new message.
 */
export const NetworkPolicyRuleSchema = /*@__PURE__*/ messageDesc(file_sandbox, 4);
/**
 * Describes the message openshell.sandbox.v1.NetworkMiddlewareConfig.
 * Use `create(NetworkMiddlewareConfigSchema)` to create a new message.
 */
export const NetworkMiddlewareConfigSchema = /*@__PURE__*/ messageDesc(file_sandbox, 5);
/**
 * Describes the message openshell.sandbox.v1.MiddlewareEndpointSelector.
 * Use `create(MiddlewareEndpointSelectorSchema)` to create a new message.
 */
export const MiddlewareEndpointSelectorSchema = /*@__PURE__*/ messageDesc(file_sandbox, 6);
/**
 * Describes the message openshell.sandbox.v1.NetworkCredentialBinding.
 * Use `create(NetworkCredentialBindingSchema)` to create a new message.
 */
export const NetworkCredentialBindingSchema = /*@__PURE__*/ messageDesc(file_sandbox, 7);
/**
 * Describes the message openshell.sandbox.v1.NetworkEndpoint.
 * Use `create(NetworkEndpointSchema)` to create a new message.
 */
export const NetworkEndpointSchema = /*@__PURE__*/ messageDesc(file_sandbox, 8);
/**
 * Describes the message openshell.sandbox.v1.McpOptions.
 * Use `create(McpOptionsSchema)` to create a new message.
 */
export const McpOptionsSchema = /*@__PURE__*/ messageDesc(file_sandbox, 9);
/**
 * Describes the message openshell.sandbox.v1.GraphqlOperation.
 * Use `create(GraphqlOperationSchema)` to create a new message.
 */
export const GraphqlOperationSchema = /*@__PURE__*/ messageDesc(file_sandbox, 10);
/**
 * Describes the message openshell.sandbox.v1.L7DenyRule.
 * Use `create(L7DenyRuleSchema)` to create a new message.
 */
export const L7DenyRuleSchema = /*@__PURE__*/ messageDesc(file_sandbox, 11);
/**
 * Describes the message openshell.sandbox.v1.L7Rule.
 * Use `create(L7RuleSchema)` to create a new message.
 */
export const L7RuleSchema = /*@__PURE__*/ messageDesc(file_sandbox, 12);
/**
 * Describes the message openshell.sandbox.v1.L7Allow.
 * Use `create(L7AllowSchema)` to create a new message.
 */
export const L7AllowSchema = /*@__PURE__*/ messageDesc(file_sandbox, 13);
/**
 * Describes the message openshell.sandbox.v1.L7QueryMatcher.
 * Use `create(L7QueryMatcherSchema)` to create a new message.
 */
export const L7QueryMatcherSchema = /*@__PURE__*/ messageDesc(file_sandbox, 14);
/**
 * Describes the message openshell.sandbox.v1.NetworkBinary.
 * Use `create(NetworkBinarySchema)` to create a new message.
 */
export const NetworkBinarySchema = /*@__PURE__*/ messageDesc(file_sandbox, 15);
/**
 * Describes the message openshell.sandbox.v1.GetSandboxConfigRequest.
 * Use `create(GetSandboxConfigRequestSchema)` to create a new message.
 */
export const GetSandboxConfigRequestSchema = /*@__PURE__*/ messageDesc(file_sandbox, 16);
/**
 * Describes the message openshell.sandbox.v1.GetGatewayConfigRequest.
 * Use `create(GetGatewayConfigRequestSchema)` to create a new message.
 */
export const GetGatewayConfigRequestSchema = /*@__PURE__*/ messageDesc(file_sandbox, 17);
/**
 * Describes the message openshell.sandbox.v1.GetGatewayConfigResponse.
 * Use `create(GetGatewayConfigResponseSchema)` to create a new message.
 */
export const GetGatewayConfigResponseSchema = /*@__PURE__*/ messageDesc(file_sandbox, 18);
/**
 * Describes the message openshell.sandbox.v1.SettingValue.
 * Use `create(SettingValueSchema)` to create a new message.
 */
export const SettingValueSchema = /*@__PURE__*/ messageDesc(file_sandbox, 19);
/**
 * Describes the message openshell.sandbox.v1.EffectiveSetting.
 * Use `create(EffectiveSettingSchema)` to create a new message.
 */
export const EffectiveSettingSchema = /*@__PURE__*/ messageDesc(file_sandbox, 20);
/**
 * Describes the message openshell.sandbox.v1.GetSandboxConfigResponse.
 * Use `create(GetSandboxConfigResponseSchema)` to create a new message.
 */
export const GetSandboxConfigResponseSchema = /*@__PURE__*/ messageDesc(file_sandbox, 21);
/**
 * Describes the message openshell.sandbox.v1.SupervisorMiddlewareService.
 * Use `create(SupervisorMiddlewareServiceSchema)` to create a new message.
 */
export const SupervisorMiddlewareServiceSchema = /*@__PURE__*/ messageDesc(file_sandbox, 22);
/**
 * Scope that currently controls a setting.
 *
 * @generated from enum openshell.sandbox.v1.SettingScope
 */
export var SettingScope;
(function (SettingScope) {
    /**
     * @generated from enum value: SETTING_SCOPE_UNSPECIFIED = 0;
     */
    SettingScope[SettingScope["UNSPECIFIED"] = 0] = "UNSPECIFIED";
    /**
     * @generated from enum value: SETTING_SCOPE_SANDBOX = 1;
     */
    SettingScope[SettingScope["SANDBOX"] = 1] = "SANDBOX";
    /**
     * @generated from enum value: SETTING_SCOPE_GLOBAL = 2;
     */
    SettingScope[SettingScope["GLOBAL"] = 2] = "GLOBAL";
})(SettingScope || (SettingScope = {}));
/**
 * Describes the enum openshell.sandbox.v1.SettingScope.
 */
export const SettingScopeSchema = /*@__PURE__*/ enumDesc(file_sandbox, 0);
/**
 * Source used for the policy payload in GetSandboxConfigResponse.
 *
 * @generated from enum openshell.sandbox.v1.PolicySource
 */
export var PolicySource;
(function (PolicySource) {
    /**
     * @generated from enum value: POLICY_SOURCE_UNSPECIFIED = 0;
     */
    PolicySource[PolicySource["UNSPECIFIED"] = 0] = "UNSPECIFIED";
    /**
     * @generated from enum value: POLICY_SOURCE_SANDBOX = 1;
     */
    PolicySource[PolicySource["SANDBOX"] = 1] = "SANDBOX";
    /**
     * @generated from enum value: POLICY_SOURCE_GLOBAL = 2;
     */
    PolicySource[PolicySource["GLOBAL"] = 2] = "GLOBAL";
})(PolicySource || (PolicySource = {}));
/**
 * Describes the enum openshell.sandbox.v1.PolicySource.
 */
export const PolicySourceSchema = /*@__PURE__*/ enumDesc(file_sandbox, 1);