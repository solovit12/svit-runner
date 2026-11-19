import { AlertTriangle } from 'lucide-react';
import { pairLegRoom } from '../../../../packages/shared/src/pair-legs';
import { InfoTooltip } from './TranslatedText';

const usdc = (value: number) => `${value.toLocaleString('en-US')} USDC`;

/**
 * A pair strategy whose legs do not fit a Paper exchange balance. Paper trades the account's own
 * cash (no leverage), and both legs of a pair open in the same instant, so the exchange refuses the
 * leg that no longer fits and the run stops. Shown before the run starts, under the balance field.
 */
export function PairLegRoomNotice({ settings }: {
  settings: Parameters<typeof pairLegRoom>[0];
}) {
  const rooms = pairLegRoom(settings);
  if (rooms.length === 0) return null;
  return <div className="paper-xyz-notice paper-leg-room-notice" role="note">
    <AlertTriangle size={16} />
    <div>
      <strong>The balance is too small for these pairs <InfoTooltip label="pair legs and the balance"
        en="Paper trades the virtual account's own cash: every open leg is paid in full from that exchange's balance, with no leverage and so no liquidation price. A pair opens both of its legs in the same instant, so the pairs that may be open at once need pairs x 2 legs x leg size on that exchange. When they do not fit, the exchange refuses the leg that no longer fits and the run stops. LIVE is different: there the real account and its leverage decide."
        ru="Paper торгует на собственные деньги виртуального счёта: каждая открытая нога оплачивается с баланса этой биржи целиком, без плеча — поэтому в Paper нет и цены ликвидации. Пара открывает обе ноги в один момент, так что парам, которые могут быть открыты одновременно, нужно «пары x 2 ноги x размер ноги» на этой бирже. Если не помещается, биржа отказывает ноге, которая уже не влезла, и прогон останавливается. В LIVE иначе: там решают настоящий счёт и его плечо." /></strong>
      {rooms.map((room) => <span key={room.venue}>
        {room.venue}: {room.pairs} pair{room.pairs === 1 ? '' : 's'} open at once &times; 2 legs &times; {usdc(room.legUsdc)}
        {' '}= {usdc(room.needed)}, over the {usdc(room.balance)} balance.
      </span>)}
      <span>Raise the starting balance to at least {usdc(Math.max(...rooms.map((room) => room.needed)))},
        or lower the leg size or the pairs open at once.</span>
    </div>
  </div>;
}
