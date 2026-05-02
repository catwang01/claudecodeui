import { Mic, Moon, Sun, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DarkModeToggle } from '../../../shared/view/ui';
import LanguageSelector from '../../../shared/view/ui/LanguageSelector';
import {
  INPUT_SETTING_TOGGLES,
  SETTING_ROW_CLASS,
  TOOL_DISPLAY_TOGGLES,
  VIEW_OPTION_TOGGLES,
} from '../constants';
import type {
  PreferenceToggleItem,
  PreferenceToggleKey,
  QuickSettingsPreferences,
} from '../types';
import type { VoiceLang } from '../../../contexts/VoiceConversationContext';
import QuickSettingsSection from './QuickSettingsSection';
import QuickSettingsToggleRow from './QuickSettingsToggleRow';

type QuickSettingsContentProps = {
  isDarkMode: boolean;
  preferences: QuickSettingsPreferences;
  onPreferenceChange: (key: PreferenceToggleKey, value: boolean) => void;
  ttsEnabled: boolean;
  ttsSupported: boolean;
  onTtsToggle: () => void;
  isVoiceSupported: boolean;
  voiceLang: VoiceLang;
  onVoiceLangChange: (lang: VoiceLang) => void;
};

export default function QuickSettingsContent({
  isDarkMode,
  preferences,
  onPreferenceChange,
  ttsEnabled,
  ttsSupported,
  onTtsToggle,
  isVoiceSupported,
  voiceLang,
  onVoiceLangChange,
}: QuickSettingsContentProps) {
  const { t } = useTranslation('settings');

  const renderToggleRows = (items: PreferenceToggleItem[]) => (
    items.map(({ key, labelKey, icon }) => (
      <QuickSettingsToggleRow
        key={key}
        label={t(labelKey)}
        icon={icon}
        checked={preferences[key]}
        onCheckedChange={(value) => onPreferenceChange(key, value)}
      />
    ))
  );

  return (
    <div className="flex-1 space-y-6 overflow-y-auto overflow-x-hidden bg-background p-4">
      <QuickSettingsSection title={t('quickSettings.sections.appearance')}>
        <div className={SETTING_ROW_CLASS}>
          <span className="flex items-center gap-2 text-sm text-gray-900 dark:text-white">
            {isDarkMode ? (
              <Moon className="h-4 w-4 text-gray-600 dark:text-gray-400" />
            ) : (
              <Sun className="h-4 w-4 text-gray-600 dark:text-gray-400" />
            )}
            {t('quickSettings.darkMode')}
          </span>
          <DarkModeToggle />
        </div>
        <LanguageSelector compact />
        {ttsSupported && (
          <QuickSettingsToggleRow
            label={t('quickSettings.tts', 'Text to Speech')}
            icon={Volume2}
            checked={ttsEnabled}
            onCheckedChange={() => onTtsToggle()}
          />
        )}
        {(isVoiceSupported || ttsSupported) && (
          <div className={SETTING_ROW_CLASS}>
            <span className="flex items-center gap-2 text-sm text-gray-900 dark:text-white">
              <Mic className="h-4 w-4 text-gray-600 dark:text-gray-400" />
              {t('quickSettings.voiceLang', '语音语言')}
            </span>
            <div className="flex overflow-hidden rounded-md border border-border text-xs">
              {(['zh-CN', 'en-US', 'auto'] as VoiceLang[]).map((lang) => (
                <button
                  key={lang}
                  type="button"
                  onClick={() => onVoiceLangChange(lang)}
                  className={`px-2 py-1 transition-colors ${
                    voiceLang === lang
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-background text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {lang === 'zh-CN' ? '中文' : lang === 'en-US' ? 'EN' : 'Auto'}
                </button>
              ))}
            </div>
          </div>
        )}
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.toolDisplay')}>
        {renderToggleRows(TOOL_DISPLAY_TOGGLES)}
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.viewOptions')}>
        {renderToggleRows(VIEW_OPTION_TOGGLES)}
      </QuickSettingsSection>

      <QuickSettingsSection title={t('quickSettings.sections.inputSettings')}>
        {renderToggleRows(INPUT_SETTING_TOGGLES)}
        <p className="ml-3 text-xs text-gray-500 dark:text-gray-400">
          {t('quickSettings.sendByCtrlEnterDescription')}
        </p>
      </QuickSettingsSection>
    </div>
  );
}
