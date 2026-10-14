// The family sender: "a tool by Pleasance", then the band dimmed with Savor's segment marked as a pill.
import { t } from './i18n'

export const PleasanceFooter = () => (
  <div class="absender">
    <a href="https://pleasance.org" target="_blank" rel="noreferrer">
      {t('a tool by')} <span class="wordmark" role="img" aria-label="Pleasance" />
    </a>
    <span class="band" aria-hidden="true">
      <i />
    </span>
  </div>
)
