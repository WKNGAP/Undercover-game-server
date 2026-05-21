import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import './styles.css';

const PHASES = ['LOBBY', 'GAMING', 'VOTING', 'BLANK_GUESS', 'FINISHED'];
const MAX_PLAYER_NAME_LENGTH = 20;

function useI18n() {
  const [dict, setDict] = useState({});
  const [lang, setLangState] = useState(() => localStorage.getItem('undercover-lang') || 'zh');

  useEffect(() => {
    fetch('/i18n.json')
      .then(res => res.json())
      .then(setDict)
      .catch(() => setDict({}));
  }, []);

  const setLang = useCallback((nextLang) => {
    const normalized = nextLang === 'en' ? 'en' : 'zh';
    localStorage.setItem('undercover-lang', normalized);
    setLangState(normalized);
  }, []);

  const t = useCallback((key, fallback) => dict[lang]?.[key] || dict.en?.[key] || fallback || key, [dict, lang]);

  return { t, lang, setLang };
}

function useSocket() {
  const socketRef = useRef(null);
  if (!socketRef.current) {
    socketRef.current = io();
  }
  useEffect(() => () => socketRef.current?.disconnect(), []);
  return socketRef.current;
}

function roleLabel(role, t) {
  if (role === 'Spy') return t('roleSpy', 'Spy');
  if (role === 'Blank') return t('roleBlank', 'Blank');
  if (role === 'Civilian') return t('roleCivilian', 'Civilian');
  return role || '';
}

function phaseLabel(phase, t) {
  const labels = {
    LOBBY: t('phaseLobby', 'Lobby'),
    GAMING: t('phaseGaming', 'In game'),
    VOTING: t('phaseVoting', 'Voting'),
    BLANK_GUESS: t('phaseBlankGuess', 'Blank guess'),
    FINISHED: t('phaseFinished', 'Finished')
  };
  return labels[phase] || phase;
}

function emptyVotes() {
  return { counts: {}, voters: [] };
}

function winnerRoleForResult(result) {
  if (result === 'civil_win') return 'Civilian';
  if (result === 'spy_win') return 'Spy';
  return null;
}

function winnerIdsForGameOver(payload) {
  if (payload.result === 'blank_win') return new Set((payload.winnerProfiles || []).map(player => player.id));
  const winnerRole = winnerRoleForResult(payload.result);
  if (!winnerRole) return new Set();
  return new Set((payload.finalRoles || []).filter(player => player.role === winnerRole).map(player => player.id));
}

function getStartIssue(joined, spies, blanks, t) {
  if (joined < 3) return t('startNeedPlayers', 'At least 3 players are required');
  if (!Number.isInteger(spies) || spies < 1) return t('startNeedSpy', 'At least 1 spy is required');
  if (!Number.isInteger(blanks) || blanks < 0) return t('startInvalidBlank', 'Invalid blank count');
  const civilians = joined - spies - blanks;
  if (spies + blanks >= joined || civilians < 1) return t('startNeedCivilian', 'Spies and blanks must leave at least 1 civilian');
  if (spies >= civilians + blanks) return t('startWouldEnd', 'Role counts already meet an end-game condition');
  return '';
}

function HostApp() {
  const { t, lang, setLang } = useI18n();
  const socket = useSocket();
  const [types, setTypes] = useState([]);
  const [form, setForm] = useState({ type: '', maxPlayers: '', spyCount: 1, blankCount: 0 });
  const [lobbyConfig, setLobbyConfig] = useState({ spyCount: 1, blankCount: 0, maxPlayers: '' });
  const [room, setRoom] = useState(null);
  const [phase, setPhase] = useState('LOBBY');
  const [players, setPlayers] = useState([]);
  const [counts, setCounts] = useState(null);
  const [votes, setVotes] = useState(emptyVotes());
  const [message, setMessage] = useState('');
  const [endgame, setEndgame] = useState('');
  const [winnerIds, setWinnerIds] = useState(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadTypes();
  }, []);

  useEffect(() => {
    const onLobby = payload => {
      setPhase(payload.state || phase);
      setPlayers(payload.players || []);
      setCounts(payload.counts || null);
      setVotes(payload.votes || emptyVotes());
      if (payload.config) {
        setLobbyConfig({
          spyCount: payload.config.spyCount ?? 1,
          blankCount: payload.config.blankCount ?? 0,
          maxPlayers: payload.config.maxPlayers || ''
        });
      }
      const capText = payload.maxPlayers ? `/${payload.maxPlayers}` : '';
      setMessage(`${t('totalPlayers', 'Players')}: ${payload.joined ?? payload.players?.length ?? 0}${capText}`);
    };
    const onStarted = ({ players: publicPlayers, counts: nextCounts, total }) => {
      setPhase('GAMING');
      setCounts(nextCounts || null);
      setVotes(emptyVotes());
      setEndgame('');
      setWinnerIds(new Set());
      setMessage(`${t('gameStartedHost', 'Game started. Check player devices.')} ${publicPlayers?.length || 0}/${total}`);
    };
    const onVoteUpdate = data => {
      setVotes(data.votes || emptyVotes());
      if (data.players) setPlayers(data.players);
    };
    const onVotingComplete = data => {
      if (data.players) setPlayers(data.players);
      setVotes(data.votes || emptyVotes());
      setCounts(data.counts || null);
      if (data.status === 'tie') {
        setPhase('GAMING');
        setMessage(t('tie', 'Tie'));
      } else if (data.result?.result === 'blank_guess') {
        setPhase('BLANK_GUESS');
        setMessage(t('blankGuessing', 'Blank guessing...'));
      } else if (data.result?.result === 'civil_win' || data.result?.result === 'spy_win') {
        setPhase('FINISHED');
      } else {
        setPhase('GAMING');
        setMessage(data.player ? `${data.player.name} ${t('playerOut', 'Out')}` : t('gameContinues', 'Game continues'));
      }
    };
    const onGameOver = payload => {
      setPhase('FINISHED');
      setPlayers(payload.finalRoles || players);
      setWinnerIds(winnerIdsForGameOver(payload));
      const names = payload.winnerProfiles?.map(p => p.name).join(', ');
      const text = payload.result === 'civil_win'
        ? t('civilianWin', 'Civilians Win')
        : payload.result === 'spy_win'
          ? t('spyWin', 'Spies Win')
          : payload.result === 'blank_win'
            ? `${t('blankWin', 'Blank Wins')} ${names || ''}`.trim()
            : t('blankGuessing', 'Blank guessing...');
      setEndgame(text);
      setMessage(text);
    };
    const onBlankStart = () => {
      setPhase('BLANK_GUESS');
      setMessage(t('blankGuessing', 'Blank guessing...'));
    };
    const onBlankEnd = ({ state }) => {
      setPhase(state || 'GAMING');
      setMessage(t('gameContinues', 'Game continues'));
    };
    const onReset = () => {
      setRoom(null);
      setPhase('LOBBY');
      setPlayers([]);
      setCounts(null);
      setVotes(emptyVotes());
      setEndgame('');
      setWinnerIds(new Set());
      setMessage('等待建立新房間...');
    };
    const onHostError = ({ message }) => setMessage(message || 'Unable to start game');

    socket.on('update_lobby', onLobby);
    socket.on('game_started', onStarted);
    socket.on('vote_update', onVoteUpdate);
    socket.on('voting_complete', onVotingComplete);
    socket.on('game_over', onGameOver);
    socket.on('blank_guess_start', onBlankStart);
    socket.on('blank_guess_end', onBlankEnd);
    socket.on('room_reset_host', onReset);
    socket.on('host_error', onHostError);

    return () => {
      socket.off('update_lobby', onLobby);
      socket.off('game_started', onStarted);
      socket.off('vote_update', onVoteUpdate);
      socket.off('voting_complete', onVotingComplete);
      socket.off('game_over', onGameOver);
      socket.off('blank_guess_start', onBlankStart);
      socket.off('blank_guess_end', onBlankEnd);
      socket.off('room_reset_host', onReset);
      socket.off('host_error', onHostError);
    };
  }, [socket, phase, players, t]);

  async function loadTypes() {
    const res = await fetch('/api/question-types');
    const data = await res.json();
    setTypes(data.types || []);
  }

  async function createRoom(event) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const res = await fetch('/api/create-room', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: form.type || null,
          maxPlayers: form.maxPlayers === '' ? null : Number(form.maxPlayers),
          spyCount: Number(form.spyCount),
          blankCount: Number(form.blankCount)
        })
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || 'Failed to create room');
        return;
      }
      setRoom(data);
      setPhase('LOBBY');
      setPlayers([]);
      setCounts(null);
      setVotes(emptyVotes());
      setEndgame('');
      setWinnerIds(new Set());
      setLobbyConfig({ spyCount: Number(form.spyCount), blankCount: Number(form.blankCount), maxPlayers: form.maxPlayers });
      setMessage(`${t('roomId', 'Room ID')}: ${data.roomId}`);
      socket.emit('host_subscribe', { roomId: data.roomId });
    } finally {
      setBusy(false);
    }
  }

  async function uploadBank(file) {
    if (!file) return;
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/api/upload-question-bank', { method: 'POST', body: formData });
    if (res.ok) {
      await loadTypes();
      setMessage(t('uploadUpdated', 'Bank updated'));
    }
  }

  const alivePlayers = players.filter(p => !p.isOut);
  const outPlayers = players.filter(p => p.isOut);
  const joined = players.filter(p => !p.isOut || p.pendingBlank).length;
  const roleCounts = {
    spies: Number(lobbyConfig.spyCount),
    blanks: Number(lobbyConfig.blankCount),
    civilians: joined - Number(lobbyConfig.spyCount) - Number(lobbyConfig.blankCount)
  };
  const startIssue = getStartIssue(joined, roleCounts.spies, roleCounts.blanks, t);
  const canStart = room && phase === 'LOBBY' && !startIssue;
  const canVote = room && !['LOBBY', 'VOTING', 'BLANK_GUESS', 'FINISHED'].includes(phase);
  const monitorMode = room && phase !== 'LOBBY';

  function updateLobbyConfig() {
    if (!room) return;
    socket.emit('update_lobby_config', {
      roomId: room.roomId,
      spyCount: Number(lobbyConfig.spyCount),
      blankCount: Number(lobbyConfig.blankCount),
      maxPlayers: lobbyConfig.maxPlayers === '' ? null : Number(lobbyConfig.maxPlayers)
    });
  }

  return (
    <div className={`app-shell host-shell ${monitorMode ? 'monitor-mode' : ''} ${phase === 'FINISHED' ? 'endgame-mode' : ''}`}>
      <header className="topbar">
        <div>
          <p className="eyebrow">Host Console</p>
          <h1>{t('title', 'Undercover')}</h1>
        </div>
        <div className="topbar-actions">
          <LanguageSwitch lang={lang} setLang={setLang} t={t} />
          <PhaseRail phase={phase} t={t} />
        </div>
      </header>

      <main className="host-layout">
        <section className="setup-panel">
          <div className="panel-heading">
            <h2>{room ? t('roomControl', 'Room Control') : t('createRoom', 'Create Room')}</h2>
            <span className={`state-pill state-${phase.toLowerCase()}`}>{phaseLabel(phase, t)}</span>
          </div>

          {!room ? (
            <form className="control-grid" onSubmit={createRoom}>
              <label>
                {t('questionType', 'Question Type')}
                <select value={form.type} onChange={event => setForm({ ...form, type: event.target.value })}>
                  <option value="">{t('defaultBank', 'Default Bank')}</option>
                  {types.map(type => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label>
                {t('maxPlayers', 'Max Players')}
                <input type="number" min="3" value={form.maxPlayers} onChange={event => setForm({ ...form, maxPlayers: event.target.value })} placeholder={t('optional', 'Optional')} />
              </label>
              <label>
                {t('spies', 'Spies')}
                <input type="number" min="1" value={form.spyCount} onChange={event => setForm({ ...form, spyCount: event.target.value })} required />
              </label>
              <label>
                {t('blanks', 'Blanks')}
                <input type="number" min="0" value={form.blankCount} onChange={event => setForm({ ...form, blankCount: event.target.value })} required />
              </label>
              <button className="primary" type="submit" disabled={busy}>{t('createRoom', 'Create Room')}</button>
              <label className="upload-control">
                {t('uploadCSV', 'Upload Custom Bank')}
                <input type="file" accept=".csv" onChange={event => uploadBank(event.target.files[0])} />
              </label>
            </form>
          ) : (
            <div className="room-control">
              <div className="room-code">{room.roomId}</div>
              <div className="lobby-config">
                <label>
                  {t('spies', 'Spies')}
                  <input type="number" min="0" value={lobbyConfig.spyCount} disabled={phase !== 'LOBBY'} onChange={event => setLobbyConfig({ ...lobbyConfig, spyCount: event.target.value })} />
                </label>
                <label>
                  {t('blanks', 'Blanks')}
                  <input type="number" min="0" value={lobbyConfig.blankCount} disabled={phase !== 'LOBBY'} onChange={event => setLobbyConfig({ ...lobbyConfig, blankCount: event.target.value })} />
                </label>
                <label>
                  {t('maxPlayers', 'Max Players')}
                  <input type="number" min="3" value={lobbyConfig.maxPlayers} disabled={phase !== 'LOBBY'} onChange={event => setLobbyConfig({ ...lobbyConfig, maxPlayers: event.target.value })} placeholder={t('optional', 'Optional')} />
                </label>
                <button disabled={phase !== 'LOBBY'} onClick={updateLobbyConfig}>{t('applySettings', 'Apply Settings')}</button>
              </div>
              {phase === 'LOBBY' && (
                <div className={`validation-note ${startIssue ? 'bad' : 'ok'}`}>
                  {startIssue || `${t('roleCivilian', 'Civilian')}: ${roleCounts.civilians}`}
                </div>
              )}
              <div className="share-grid">
                <img className="qr" src={room.qr} alt="QR code" />
                <div>
                  <label>
                    {t('roomLink', 'Room Link')}
                    <input readOnly value={room.url} onFocus={event => event.target.select()} />
                  </label>
                  <div className="button-row">
                    <button className="primary" disabled={!canStart} onClick={() => socket.emit('start_game', { roomId: room.roomId })}>{t('startGame', 'Start Game')}</button>
                    <button disabled={!canVote} onClick={() => socket.emit('start_vote', { roomId: room.roomId })}>{t('vote', 'Vote')}</button>
                    <button onClick={() => socket.emit('host_resync', { roomId: room.roomId })}>重新同步</button>
                  </div>
                </div>
              </div>
              {phase === 'FINISHED' && (
                <div className="button-row">
                  <button className="primary" onClick={() => socket.emit('restart_game', { roomId: room.roomId, keepPlayers: true })}>同班重開</button>
                  <button onClick={() => socket.emit('restart_game', { roomId: room.roomId, keepPlayers: false })}>重新開始</button>
                </div>
              )}
            </div>
          )}

          <div className="status-strip">
            <strong>{message || 'Ready'}</strong>
            {counts && <span>{t('spies', 'Spies')}: {counts.spies} / {t('blanks', 'Blanks')}: {counts.blanks} / {t('roleCivilian', 'Civilian')}: {counts.civilians}</span>}
          </div>
          {endgame && <div className="endgame-banner"><span>{t('finalResult', 'Final Result')}</span><strong>{endgame}</strong></div>}
        </section>

        <section className="roster-panel">
          <div className="panel-heading">
            <h2>{t('lobbyHeading', 'Lobby')}</h2>
            <span>{joined}{lobbyConfig.maxPlayers ? `/${lobbyConfig.maxPlayers}` : ''}</span>
          </div>
          <PlayerGrid
            players={alivePlayers}
            votes={votes.counts || {}}
            showRole={phase === 'FINISHED'}
            t={t}
            empty="No active players yet."
            actionLabel={phase === 'LOBBY' ? t('kickPlayer', 'Kick') : t('outPlayer', 'Out')}
            onKick={playerId => socket.emit('host_kick_player', { roomId: room?.roomId, playerId })}
            winnerIds={winnerIds}
          />
          <div className="panel-heading out-heading">
            <h2>出局</h2>
            <span>{outPlayers.length}</span>
          </div>
          <PlayerGrid players={outPlayers} votes={votes.counts || {}} showRole={phase === 'FINISHED'} t={t} empty="No players out." winnerIds={winnerIds} />
        </section>
      </main>
    </div>
  );
}

function PhaseRail({ phase, t }) {
  return (
    <div className="phase-rail">
      {PHASES.map(item => (
        <span key={item} className={item === phase ? 'active' : ''}>{phaseLabel(item, t)}</span>
      ))}
    </div>
  );
}

function LanguageSwitch({ lang, setLang, t }) {
  return (
    <label className="language-switch">
      {t('language', 'Language')}
      <select value={lang} onChange={event => setLang(event.target.value)}>
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
    </label>
  );
}

function PlayerGrid({ players, votes, showRole, t, empty, actionLabel, onKick, winnerIds = new Set() }) {
  if (!players.length) return <div className="empty-state">{empty}</div>;
  return (
    <div className="player-grid">
      {players.map(player => (
        <article className={`player-card ${player.isOut ? 'is-out' : ''} ${winnerIds.has(player.id) ? 'winner-card' : ''}`} key={player.id}>
          <div className="avatar">{player.image ? <img src={player.image} alt={player.name} /> : <span>{player.name?.slice(0, 1) || '?'}</span>}</div>
          <div className="player-main">
            <strong title={player.name}>{player.name}</strong>
            {winnerIds.has(player.id) && <em>{t('winnerLabel', 'Winner')}</em>}
            {showRole && player.role && <span>{roleLabel(player.role, t)} · {player.word || t('noWord', 'No word')}</span>}
            {player.pendingBlank && <span>{t('blankGuessing', 'Blank guessing...')}</span>}
          </div>
          <div className="vote-badge">Votes {votes[player.id] || 0}</div>
          {onKick && (
            <button className="danger small-action" onClick={() => onKick(player.id)}>{actionLabel}</button>
          )}
        </article>
      ))}
    </div>
  );
}

function PlayerApp() {
  const { t, lang, setLang } = useI18n();
  const socket = useSocket();
  const roomId = useMemo(() => window.location.pathname.split('/').filter(Boolean).pop() || '', []);
  const storageKey = `undercover-${roomId}`;
  const [player, setPlayer] = useState({ id: localStorage.getItem(storageKey), name: '' });
  const [joinName, setJoinName] = useState('');
  const [photoPreview, setPhotoPreview] = useState('');
  const [photoBase64, setPhotoBase64] = useState('');
  const [word, setWord] = useState('');
  const [phase, setPhase] = useState('LOBBY');
  const [status, setStatus] = useState(t('waiting', 'Waiting for players...'));
  const [players, setPlayers] = useState([]);
  const [selectedVote, setSelectedVote] = useState('');
  const [blankGuessing, setBlankGuessing] = useState(false);
  const [blankGuess, setBlankGuess] = useState('');
  const [playerOut, setPlayerOut] = useState(false);
  const [finalRole, setFinalRole] = useState('');
  const [joinedCount, setJoinedCount] = useState('');

  useEffect(() => {
    if (player.id) {
      socket.emit('join_game', { roomId, playerId: player.id });
      setStatus(t('reconnecting', 'Reconnecting...'));
    }
  }, [socket, roomId]);

  useEffect(() => {
    const onJoined = data => {
      localStorage.setItem(storageKey, data.playerId);
      setPlayer({ id: data.playerId, name: data.name || '' });
      setPlayerOut(false);
      setFinalRole('');
      setStatus(`${t('name', 'Name')}: ${data.name || ''} - ${t('waiting', 'Waiting for players...')}`);
    };
    const onWord = ({ word }) => {
      setWord(word || '');
      setStatus(t('gameStartedPlayer', 'Game started. Please vote.'));
    };
    const onStarted = payload => {
      setPhase('GAMING');
      setPlayers(payload.players || []);
      setBlankGuessing(false);
      setPlayerOut(false);
      setSelectedVote('');
      setStatus(t('gameStartedPlayer', 'Game started. Please vote.'));
    };
    const onVoteBegin = ({ players }) => {
      setPhase('VOTING');
      setPlayers(players || []);
      setSelectedVote('');
      setBlankGuessing(false);
      setStatus(playerOut ? t('playerOut', 'Out') : '');
    };
    const onVotingComplete = data => {
      if (data.status === 'tie') setStatus(t('tie', 'Tie'));
      if (data.status === 'out' && data.player) setStatus(`${data.player.name} ${t('playerOut', 'Out')}`);
      if (data.result?.result === 'blank_guess') setStatus(t('blankGuessing', 'Blank guessing...'));
      if (data.player?.id === player.id) {
        setPlayerOut(true);
        setStatus(t('playerOut', 'Out'));
      }
      setPhase(data.result?.result === 'blank_guess' ? 'BLANK_GUESS' : 'GAMING');
    };
    const onOut = () => {
      setPlayerOut(true);
      setStatus(t('playerOut', 'Out'));
      setBlankGuessing(false);
    };
    const onLobby = payload => {
      const joined = payload.joined ?? payload.players?.length ?? 0;
      setJoinedCount(`${joined}${payload.maxPlayers ? `/${payload.maxPlayers}` : ''}`);
    };
    const onGameOver = payload => {
      setPhase('FINISHED');
      setPlayerOut(true);
      setBlankGuessing(false);
      const mine = payload.finalRoles?.find(item => item.id === player.id);
      if (mine) setFinalRole(mine.role);
      const winnerRoles = payload.result === 'civil_win' ? ['Civilian'] : payload.result === 'spy_win' ? ['Spy'] : payload.result === 'blank_win' ? ['Blank'] : [];
      const resultText = payload.result === 'civil_win'
        ? t('civilianWin', 'Civilians Win')
        : payload.result === 'spy_win'
          ? t('spyWin', 'Spies Win')
          : payload.result === 'blank_win'
            ? t('blankWin', 'Blank Wins')
            : t('blankGuessing', 'Blank guessing...');
      const outcome = mine && winnerRoles.length ? (winnerRoles.includes(mine.role) ? '勝利' : '失敗') : '';
      setStatus([resultText, mine ? `${roleLabel(mine.role, t)}${outcome ? `: ${outcome}` : ''}` : ''].filter(Boolean).join(' - '));
    };
    const onRoomMissing = () => {
      localStorage.removeItem(storageKey);
      setPlayer({ id: null, name: '' });
      setStatus(t('roomNotFound', 'Room not found'));
    };
    const onKicked = () => {
      localStorage.removeItem(storageKey);
      setPlayer({ id: null, name: '' });
      setPlayerOut(false);
      setFinalRole('');
      setWord('');
      setPlayers([]);
      setBlankGuessing(false);
      setPhase('LOBBY');
      setStatus(t('kickedMessage', 'You were removed from the room'));
    };
    const onResetWait = () => {
      setPhase('LOBBY');
      setStatus('等待房間建立...');
      setPlayerOut(false);
      setFinalRole('');
      setWord('');
    };
    const onRedirect = ({ roomId: nextRoomId, name, image, playerId }) => {
      if (playerId) localStorage.setItem(`undercover-${nextRoomId}`, playerId);
      socket.emit('join_game', { roomId: nextRoomId, name, existingImage: image, playerId });
    };
    const onBlankPrompt = () => {
      setPhase('BLANK_GUESS');
      setBlankGuessing(true);
      setStatus(t('blankGuessing', 'Blank guessing...'));
    };
    const onBlankWait = () => {
      setPhase('BLANK_GUESS');
      setBlankGuessing(false);
      setStatus(t('blankGuessing', 'Blank guessing...'));
    };
    const onBlankEnd = () => {
      setPhase('GAMING');
      setBlankGuessing(false);
      setStatus(t('gameContinues', 'Game continues'));
    };
    const onDisconnect = () => setStatus(t('reconnecting', 'Reconnecting...'));

    socket.on('joined', onJoined);
    socket.on('your_word', onWord);
    socket.on('game_started', onStarted);
    socket.on('vote_begin', onVoteBegin);
    socket.on('voting_complete', onVotingComplete);
    socket.on('you_out', onOut);
    socket.on('update_lobby', onLobby);
    socket.on('game_over', onGameOver);
    socket.on('room_not_found', onRoomMissing);
    socket.on('kicked', onKicked);
    socket.on('room_reset_wait', onResetWait);
    socket.on('redirect_room', onRedirect);
    socket.on('blank_guess_start', onBlankPrompt);
    socket.on('blank_guess_prompt', onBlankPrompt);
    socket.on('blank_guess_wait', onBlankWait);
    socket.on('blank_guess_end', onBlankEnd);
    socket.on('disconnect', onDisconnect);

    return () => {
      socket.off('joined', onJoined);
      socket.off('your_word', onWord);
      socket.off('game_started', onStarted);
      socket.off('vote_begin', onVoteBegin);
      socket.off('voting_complete', onVotingComplete);
      socket.off('you_out', onOut);
      socket.off('update_lobby', onLobby);
      socket.off('game_over', onGameOver);
      socket.off('room_not_found', onRoomMissing);
      socket.off('kicked', onKicked);
      socket.off('room_reset_wait', onResetWait);
      socket.off('redirect_room', onRedirect);
      socket.off('blank_guess_start', onBlankPrompt);
      socket.off('blank_guess_prompt', onBlankPrompt);
      socket.off('blank_guess_wait', onBlankWait);
      socket.off('blank_guess_end', onBlankEnd);
      socket.off('disconnect', onDisconnect);
    };
  }, [socket, roomId, storageKey, player.id, playerOut, t]);

  async function onPhoto(file) {
    if (!file) return;
    const dataUrl = await compressImage(file);
    setPhotoBase64(dataUrl);
    setPhotoPreview(dataUrl);
  }

  function join(event) {
    event.preventDefault();
    socket.emit('join_game', { roomId, name: joinName, photoBase64, playerId: player.id });
  }

  function leave() {
    if (player.id) socket.emit('leave_room', { roomId, playerId: player.id });
    localStorage.removeItem(storageKey);
    window.location.reload();
  }

  const hasJoined = !!player.id;
  const voteTargets = players.filter(item => item.id !== player.id && !item.isOut);

  return (
    <div className="player-shell">
      <main className="phone-frame">
        <header className="player-header">
          <div>
            <p className="eyebrow">{t('roomId', 'Room ID')}</p>
            <h1>{roomId}</h1>
          </div>
          <div className="player-header-actions">
            <LanguageSwitch lang={lang} setLang={setLang} t={t} />
            <span className={`state-pill state-${phase.toLowerCase()}`}>{phaseLabel(phase, t)}</span>
          </div>
        </header>

        {!hasJoined ? (
          <form className="join-card" onSubmit={join}>
            <h2>{t('playerJoinTitle', 'Join Game')}</h2>
            <label>
              {t('name', 'Name')}
              <input value={joinName} maxLength={MAX_PLAYER_NAME_LENGTH} onChange={event => setJoinName(event.target.value.slice(0, MAX_PLAYER_NAME_LENGTH))} placeholder={t('name', 'Name')} />
              <span className="field-hint">{joinName.length}/{MAX_PLAYER_NAME_LENGTH}</span>
            </label>
            <label>
              {t('photoOptional', 'Photo (optional)')}
              <input type="file" accept="image/*" onChange={event => onPhoto(event.target.files[0])} />
            </label>
            {photoPreview && <img className="photo-preview" src={photoPreview} alt="Preview" />}
            <button className="primary" type="submit">{t('join', 'Join')}</button>
            <p className="muted">{status}</p>
          </form>
        ) : (
          <section className="game-card">
            <div className="identity-row">
              <div>
                <span>{t('name', 'Name')}</span>
                <strong>{player.name || joinName || '-'}</strong>
              </div>
              <div>
                <span>{t('totalPlayers', 'Players')}</span>
                <strong>{joinedCount || '-'}</strong>
              </div>
            </div>

            <div className="word-panel">
              <span>{t('yourWord', 'Your Word')}</span>
              <strong>{word || (phase === 'FINISHED' && finalRole ? roleLabel(finalRole, t) : '-')}</strong>
            </div>

            <div className="task-panel">
              <h2>{status || t('waiting', 'Waiting for players...')}</h2>
              {phase === 'VOTING' && !playerOut && (
                <div className="vote-list">
                  {voteTargets.map(target => (
                    <label className={`vote-card ${selectedVote === target.id ? 'selected' : ''}`} key={target.id}>
                      <input type="radio" name="voteTarget" value={target.id} checked={selectedVote === target.id} onChange={() => setSelectedVote(target.id)} />
                      <span className="avatar small">{target.image ? <img src={target.image} alt={target.name} /> : target.name?.slice(0, 1)}</span>
                      <strong>{target.name}</strong>
                    </label>
                  ))}
                  <button className="primary" disabled={!selectedVote} onClick={() => {
                    socket.emit('cast_vote', { roomId, voterId: player.id, targetId: selectedVote });
                    setStatus(t('voteSubmitted', 'Voted'));
                  }}>{t('vote', 'Vote')}</button>
                </div>
              )}

              {blankGuessing && (
                <div className="blank-form">
                  <input value={blankGuess} onChange={event => setBlankGuess(event.target.value)} placeholder="輸入平民詞語" />
                  <button className="primary" onClick={() => {
                    socket.emit('blank_guess_submit', { roomId, playerId: player.id, guess: blankGuess });
                    setBlankGuessing(false);
                    setBlankGuess('');
                  }}>送出</button>
                </div>
              )}
            </div>

            <button className="ghost" onClick={leave}>離開</button>
          </section>
        )}
      </main>
    </div>
  );
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const max = 512;
        let { width, height } = img;
        if (width > height && width > max) {
          height = Math.round(height * (max / width));
          width = max;
        } else if (height > width && height > max) {
          width = Math.round(width * (max / height));
          height = max;
        } else if (width > max) {
          width = max;
          height = max;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function App() {
  return window.location.pathname.startsWith('/join/') ? <PlayerApp /> : <HostApp />;
}

createRoot(document.getElementById('root')).render(<App />);
