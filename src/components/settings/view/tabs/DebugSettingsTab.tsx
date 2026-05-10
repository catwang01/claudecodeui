import { Bug, ExternalLink, Radio } from 'lucide-react';

export default function DebugSettingsTab() {
  return (
    <div className="space-y-6 md:space-y-8">
      {/* Header */}
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Bug className="w-5 h-5 text-orange-500" />
          <h3 className="text-lg font-medium text-foreground">Debug Tools</h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Developer tools for inspecting internal behavior.
        </p>
      </div>

      {/* Claude-tap section */}
      <div className="space-y-4 bg-card border border-border rounded-lg p-4">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-muted-foreground flex-shrink-0" />
            <span className="text-sm font-medium text-foreground">API Traffic Inspector</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Intercept Claude API traffic per session. Enable tap from the chat toolbar for any
            session. Requires{' '}
            <code className="text-xs bg-muted px-1 rounded">pip install claude-tap</code>.
          </p>
          <a
            href="/tap"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline mt-1"
          >
            View active tap sessions
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </div>
    </div>
  );
}
