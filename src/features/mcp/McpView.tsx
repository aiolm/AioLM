import { memo, useMemo } from "react";
import type { McpTool } from "../../shared/api/index";
import { shouldConfirmDestructive } from "../../shared/config/preferences";
import { useI18n } from "../../shared/i18n/i18n";
import { normalizeDisplayPath, normalizeDisplayPathLines, normalizeDisplayText } from "../../shared/lib/displayPaths";
import Badge from "../../shared/ui/Badge";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import EmptyState from "../../shared/ui/EmptyState";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import PanelFeedback from "../../shared/ui/PanelFeedback";
import StableLabel from "../../shared/ui/StableLabel";
import StatusBadge from "../../shared/ui/StatusBadge";
import Switch from "../../shared/ui/Switch";
import { LocalTaskCancelButton } from "../../shared/ui/TaskCancellation";
import type { McpController } from "./mcpControllerSupport";
import { mcpDraftCopy } from "./mcpDraftCopy";

const McpToolSchema = memo(function McpToolSchema({ tool }: { tool: McpTool }) {
  const { t } = useI18n();
  const display = useMemo(() => normalizeDisplayText(JSON.stringify(tool.input_schema, null, 2)), [tool.input_schema]);
  return <pre role="region" tabIndex={0} aria-label={t("ui.inputSchema")} className="mcp-code">{display}</pre>;
});

export default function McpView({ controller }: { controller: McpController }) {
  const { t, locale } = useI18n();
  const draftCopy = mcpDraftCopy[locale];
  const {
    servers, selectedId, name, setName, command, setCommand, commandEdited, setCommandEdited,
    argsText, setArgsText, enabled, setEnabled, pendingNavigation, saving, approvalPolicy,
    tools, toolLoading, error, setError, notice, setNotice, selectedTool, setSelectedTool,
    argsJson, setArgsJson, approval, setApproval, approvalBusy, result, setResult,
    pendingDelete, removingIds, deleteButtonRefs, approvalSectionRef, reviewButtonRef,
    openDeleteDialog, closeDeleteDialog, requestNavigation, keepEditing, discardDraft,
    save, doRemove, discoverTools, prepareCall, approveCall, cancelActiveCall, changeApprovalPolicy,
    selectedServer, displayMcpCommand, enabledCount, runningCall, resultFailed,
  } = controller;

  return (
    <div className="app-page-scroll mcp-page">
      <header className="app-page-header"><div><h1 className="app-page-title">{t("section.mcp")}</h1><p className="app-page-description">{t("ui.mcpIntro")}</p></div></header>
      <FeedbackBanner tone="warning" className="mcp-security-note">{t("ui.mcpWarning")}</FeedbackBanner>
      <PanelFeedback>
        {error && <FeedbackBanner tone="error" title={t("panel.mcpActionFailed")} onDismiss={() => setError(null)}>{error}</FeedbackBanner>}
        {notice && <FeedbackBanner tone="success" title={t("panel.done")} onDismiss={() => setNotice(null)}>{notice}</FeedbackBanner>}
      </PanelFeedback>

      <div className="app-master-detail mcp-workspace">
        <aside className="mcp-servers" aria-labelledby="mcp-servers-title">
          <div className="mcp-servers__header">
            <div className="min-w-0">
              <h2 id="mcp-servers-title" className="mcp-heading">{t("panel.configuredServers")}</h2>
              <p className="mcp-hint">{t("ui.mcpConfigured", { count: servers.length })} · {t("ui.mcpEnabledCount", { count: enabledCount })}</p>
            </div>
            <button type="button" data-icon="add" onClick={() => requestNavigation(null)} className="app-button app-button--secondary app-button--sm">{t("panel.newItem")}</button>
          </div>
          {servers.length === 0
            ? <EmptyState title={t("panel.noMcpServers")} description={t("ui.mcpEmptyHint")} />
            : <ul className="mcp-server-list" aria-label={t("panel.ariaConfiguredServers")}>
              {servers.map((server) => <li key={server.id} className={`app-list-row mcp-server-row ${server.id === selectedId ? "is-selected" : ""}`}>
                <button type="button" onClick={() => requestNavigation(server)} aria-current={server.id === selectedId ? "true" : undefined} className="app-list-row__action mcp-server-row__select">
                  <span className="mcp-server-row__name">{normalizeDisplayText(server.name)}</span>
                  <StatusBadge label={server.enabled ? t("ui.enabled") : t("ui.disabled")} tone={server.enabled ? "success" : "neutral"} />
                </button>
                <button type="button" ref={(element) => { deleteButtonRefs.current[server.id] = element; }} onClick={() => { if (shouldConfirmDestructive()) openDeleteDialog(server); else void doRemove(server); }} aria-label={t("ui.removeNamed", { name: normalizeDisplayText(server.name) })} className="app-icon-button app-icon-button--danger"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" /></svg></button>
              </li>)}
            </ul>}
        </aside>

        <div className="mcp-detail">
          <section className="app-card mcp-section" aria-labelledby="mcp-definition-title">
            <div className="mcp-section__header">
              <div><h2 id="mcp-definition-title" className="app-section-title">{t("ui.serverDefinition")}</h2><p className="app-section-hint">{t("ui.serverDefinitionHint")}</p></div>
              <div className="mcp-enabled"><Switch id="mcp-server-enabled" checked={enabled} onChange={setEnabled} /><label htmlFor="mcp-server-enabled">{t("ui.enabled")}</label></div>
            </div>
            <div className="grid gap-3 app-form-grid">
              <label className="mcp-field">{t("ui.fieldName")}<input value={normalizeDisplayText(name)} onChange={(event) => setName(event.target.value)} placeholder={t("ui.fieldNamePlaceholder")} className="app-input" /></label>
              <label className="mcp-field">{t("ui.fieldCommand")}<input spellCheck={false} autoCorrect="off" autoCapitalize="off" value={commandEdited ? command : normalizeDisplayPath(command)} onChange={(event) => { setCommandEdited(true); setCommand(event.target.value); }} placeholder="npx or C:\\Tools\\server.exe" className="app-input font-mono" /></label>
            </div>
            <label className="mcp-field">{t("ui.fieldArgs")}<textarea spellCheck={false} autoCorrect="off" autoCapitalize="off" value={normalizeDisplayPathLines(argsText)} onChange={(event) => setArgsText(event.target.value)} rows={4} placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Documents"} className="app-textarea app-mono" /></label>
            <div className="mcp-actions">
              {selectedServer && <code className="mcp-command-preview" title={displayMcpCommand}>{displayMcpCommand}</code>}
              <button type="button" onClick={() => void save()} disabled={saving} aria-busy={saving} className="app-button app-button--primary">{t("ui.saveServer")}</button>
            </div>
          </section>

          <div className="app-card mcp-policy">
            <label htmlFor="mcp-approval-policy">{t("ui.approvalPolicy")}</label>
            <CustomSelect id="mcp-approval-policy" value={approvalPolicy} options={[{ value: "always-ask", label: t("ui.policyAlwaysAsk") }, { value: "once", label: t("ui.policyOnce") }, { value: "session", label: t("ui.policySession") }, { value: "server-tool", label: t("ui.policyServerTool") }, { value: "deny", label: t("ui.policyDeny") }]} onChange={(val) => changeApprovalPolicy(val)} />
          </div>

          {selectedServer && <section className="app-card mcp-section" aria-labelledby="mcp-tools-title">
            <div className="mcp-section__header">
              <div><h2 id="mcp-tools-title" className="app-section-title">{t("ui.toolsTitle")}{tools.length > 0 && <Badge>{tools.length}</Badge>}</h2><p className="app-section-hint">{t("ui.toolsHint")}</p></div>
              <button type="button" data-icon="probe" onClick={() => void discoverTools()} disabled={saving || toolLoading || !selectedServer.enabled} className="app-button app-button--secondary"><StableLabel value={toolLoading ? t("ui.discovering") : t("ui.discoverTools")} labels={[t("ui.discovering"), t("ui.discoverTools")]} /></button>
            </div>
            {tools.length === 0
              ? <p className="mcp-hint">{t("ui.discoverToolsHint")}</p>
              : <ul className="mcp-tool-list">{tools.map((tool) => <li key={tool.name} className={`app-list-row mcp-tool ${selectedTool?.name === tool.name ? "is-selected" : ""}`}>
                <div className="mcp-tool__head">
                  <div className="min-w-0"><code className="mcp-tool__name">{normalizeDisplayText(tool.name)}</code><p className="mcp-hint">{normalizeDisplayText(tool.description || t("ui.noToolDescription"))}</p></div>
                  <button type="button" disabled={saving} onClick={() => { setSelectedTool(tool); setArgsJson("{}\n"); setApproval(null); setResult(null); }} aria-label={`${t("ui.prepareCall")}: ${normalizeDisplayText(tool.name)}`} className="app-button app-button--secondary app-button--sm">{t("ui.prepareCall")}</button>
                </div>
                {selectedTool?.name === tool.name && <div className="mcp-call">
                  <label className="mcp-field">{t("ui.jsonArguments")}<textarea spellCheck={false} autoCorrect="off" autoCapitalize="off" value={normalizeDisplayText(argsJson)} onChange={(event) => setArgsJson(event.target.value)} rows={4} className="app-textarea app-mono" /></label>
                  <details className="mcp-schema"><summary>{t("ui.inputSchema")}</summary><McpToolSchema tool={tool} /></details>
                  <div><button ref={reviewButtonRef} type="button" onClick={prepareCall} disabled={saving} className="app-button app-button--primary">{t("ui.reviewToolCall")}</button></div>
                </div>}
              </li>)}</ul>}
          </section>}

          {approval && selectedServer && <section ref={approvalSectionRef} tabIndex={-1} className="app-card app-card--warning mcp-section mcp-focus-target" role="alert" aria-labelledby="mcp-approval-title">
            <div><h2 id="mcp-approval-title" className="app-section-title">{t("ui.approveTitle")}</h2><p className="app-section-hint">{t("ui.approveBody", { tool: normalizeDisplayText(approval.tool.name), server: normalizeDisplayText(selectedServer.name) })}</p></div>
            <pre role="region" tabIndex={0} aria-label={t("ui.approveTitle")} className="mcp-code">{normalizeDisplayText(JSON.stringify(approval.args, null, 2))}</pre>
            <div className="mcp-button-row">
              <button type="button" disabled={saving || approvalBusy} onClick={() => void approveCall()} className="app-button app-button--primary"><StableLabel value={approvalBusy ? t("ui.approveRunning") : t("ui.approveRun")} labels={[t("ui.approveRunning"), t("ui.approveRun")]} /></button>
              <button type="button" disabled={approvalBusy} onClick={() => { setApproval(null); reviewButtonRef.current?.focus(); }} className="app-button app-button--secondary">{t("panel.cancel")}</button>
            </div>
          </section>}

          {runningCall && <section ref={approvalSectionRef} tabIndex={-1} className="app-card mcp-running mcp-focus-target" role="status">
            <span className="mcp-running__label">{t("ui.approveRunning")}: {normalizeDisplayText(runningCall.label)}</span>
            <LocalTaskCancelButton taskId={runningCall.taskId} onClick={() => void cancelActiveCall()}>{t("panel.cancel")}</LocalTaskCancelButton>
          </section>}

          {result !== null && <section className={resultFailed ? "app-card mcp-section" : "app-card app-card--success mcp-section"}>
            <h2 id="mcp-result-title" className={`app-section-title ${resultFailed ? "text-error" : "text-success"}`}>{t("ui.toolResult")}</h2>
            <pre role="region" tabIndex={0} aria-label={t("ui.toolResult")} className="mcp-code mcp-code--tall">{normalizeDisplayText(typeof result === "string" ? result : JSON.stringify(result, null, 2))}</pre>
          </section>}
        </div>
      </div>

      <ConfirmDialog
        open={pendingNavigation !== null}
        title={draftCopy.title}
        description={draftCopy.body}
        confirmLabel={draftCopy.discard}
        cancelLabel={draftCopy.keep}
        confirmIcon="delete"
        onConfirm={discardDraft}
        onCancel={keepEditing}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("ui.deleteServerTitle")}
        description={t("ui.deleteServerBody", { name: normalizeDisplayText(pendingDelete?.server.name ?? "") })}
        confirmLabel={t("ui.deleteServer")}
        cancelLabel={t("panel.cancel")}
        confirmIcon="delete"
        confirmDisabled={pendingDelete !== null && removingIds.has(pendingDelete.server.id)}
        onConfirm={() => { if (pendingDelete) void doRemove(pendingDelete.server, pendingDelete); }}
        onCancel={closeDeleteDialog}
      />
    </div>
  );
}
