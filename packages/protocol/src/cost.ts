import type { ChannelConfig } from './types.js';

const realtimeTranslatePerMinuteUsd = 0.034;
const liveTranscribePerMinuteUsd = 0.017;

export function estimateCloudServiceCost(
  durationMinutes: number,
  channels: readonly ChannelConfig[],
): number {
  const translatedChannels = channels.filter(
    (channel) =>
      channel.voiceMode !== 'source' && channel.translationProvider === 'openai-realtime',
  ).length;
  const usesCloud = channels.some((channel) => channel.translationProvider.startsWith('openai-'));
  const transcribeCost = usesCloud ? durationMinutes * liveTranscribePerMinuteUsd : 0;
  const translateCost = durationMinutes * translatedChannels * realtimeTranslatePerMinuteUsd;
  return Number((transcribeCost + translateCost).toFixed(2));
}
