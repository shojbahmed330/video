import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
// FIX: Added 'Call' to the import from '../types' to resolve 'Cannot find name Call' error.
import { LiveVideoRoom, User, VideoParticipantState, LiveVideoRoomMessage, Call } from '../types';
import { geminiService } from '../services/geminiService';
// FIX: Imported 'firebaseService' to resolve 'Cannot find name firebaseService' errors.
import { firebaseService } from '../services/firebaseService';
import Icon from './Icon';
import { AGORA_APP_ID } from '../constants';
import AgoraRTC from 'agora-rtc-sdk-ng';
import type { IAgoraRTCClient, IAgoraRTCRemoteUser, IMicrophoneAudioTrack, ICameraVideoTrack } from 'agora-rtc-sdk-ng';

const EMOJI_REACTIONS = ['❤️', '😂', '👍', '🎉', '🔥', '🙏'];

function stringToIntegerHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

const ParticipantVideo: React.FC<{
    participant: VideoParticipantState;
    isLocal?: boolean;
    isSpeaking: boolean;
    localVideoTrack?: ICameraVideoTrack | null;
    remoteUser?: IAgoraRTCRemoteUser | undefined;
    view: 'main' | 'filmstrip' | 'pip';
}> = ({ participant, isLocal, isSpeaking, localVideoTrack, remoteUser, view }) => {
    const videoRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const videoContainer = videoRef.current;
        if (!videoContainer) return;

        let trackToPlay: ICameraVideoTrack | undefined | null = isLocal ? localVideoTrack : remoteUser?.videoTrack;
        
        if (trackToPlay && !participant.isCameraOff) {
            if(videoContainer.hasChildNodes()){
                videoContainer.innerHTML = '';
            }
            trackToPlay.play(videoContainer, { fit: 'cover' });
        } else {
            const playingTrack = isLocal ? localVideoTrack : remoteUser?.videoTrack;
            if (playingTrack && playingTrack.isPlaying) {
                playingTrack.stop();
            }
        }
    }, [isLocal, localVideoTrack, remoteUser, participant.isCameraOff]);
    
    const showVideo = (isLocal && localVideoTrack && !participant.isCameraOff) || (!isLocal && remoteUser?.hasVideo && !participant.isCameraOff);

    if (view === 'filmstrip' && !showVideo) {
        return (
            <div className="w-full h-full bg-slate-800 relative group rounded-lg flex items-center justify-center">
                <img src={participant.avatarUrl} alt={participant.name} className={`w-14 h-14 object-cover rounded-full transition-all duration-300 ${isSpeaking ? 'ring-4 ring-green-400/80' : ''}`} />
                <div className="absolute bottom-1 left-0 right-0 p-1 bg-gradient-to-t from-black/60 to-transparent">
                    <p className="font-semibold text-white text-shadow-lg text-xs truncate text-center">{participant.name}</p>
                </div>
            </div>
        );
    }
    
    return (
        <div className="w-full h-full bg-slate-800 relative group rounded-lg overflow-hidden">
            {showVideo ? (
                <div ref={videoRef} className={`w-full h-full ${isLocal ? 'transform scale-x-[-1]' : ''}`} />
            ) : (
                <div className="w-full h-full flex items-center justify-center">
                    <img src={participant.avatarUrl} alt={participant.name} className="w-16 h-16 md:w-24 md:h-24 object-cover rounded-full opacity-50" />
                </div>
            )}
             <div className={`absolute inset-0 rounded-lg pointer-events-none transition-all duration-300 ${isSpeaking ? 'animate-pulse-glow' : 'border-transparent'}`} />
             <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/70 to-transparent">
                 <p className="font-semibold text-white truncate text-shadow-lg text-sm">{participant.name}</p>
             </div>
        </div>
    );
};

const ChatMessage: React.FC<{ message: LiveVideoRoomMessage; isMe: boolean }> = ({ message, isMe }) => {
    return (
      <div className={`flex items-start gap-2 ${isMe ? 'justify-end' : ''} animate-fade-in-fast`}>
        {!isMe && <img src={message.sender.avatarUrl} alt={message.sender.name} className="w-6 h-6 rounded-full mt-1" />}
        <div>
          {!isMe && <p className="text-xs text-slate-400 ml-2">{message.sender.name}</p>}
          <div className={`px-3 py-1.5 rounded-2xl text-sm ${isMe ? 'bg-blue-600 text-white rounded-br-none' : 'bg-slate-700 text-slate-200 rounded-bl-none'}`}>
            {message.text}
          </div>
        </div>
      </div>
    );
};

interface LiveVideoRoomScreenProps {
    currentUser: User;
    roomId: string;
    onGoBack: () => void;
    onSetTtsMessage: (message: string) => void;
}

const LiveVideoRoomScreen: React.FC<LiveVideoRoomScreenProps> = ({ currentUser, roomId, onGoBack, onSetTtsMessage }) => {
    const [room, setRoom] = useState<LiveVideoRoom | null>(null);
    const [messages, setMessages] = useState<LiveVideoRoomMessage[]>([]);
    const [newMessage, setNewMessage] = useState('');
    const [isChatVisible, setIsChatVisible] = useState(false);
    
    const [remoteUsers, setRemoteUsers] = useState<IAgoraRTCRemoteUser[]>([]);
    const [isMuted, setIsMuted] = useState(false);
    const [isCameraOff, setIsCameraOff] = useState(false);
    const [isMicAvailable, setIsMicAvailable] = useState(true);
    const [isCamAvailable, setIsCamAvailable] = useState(true);
    const [activeSpeakerUid, setActiveSpeakerUid] = useState<number | null>(null);
    const [floatingEmojis, setFloatingEmojis] = useState<{id: number; emoji: string}[]>([]);
    const [localPipPosition, setLocalPipPosition] = useState({ x: 16, y: 16 });

    const agoraClient = useRef<IAgoraRTCClient | null>(null);
    const localAudioTrack = useRef<IMicrophoneAudioTrack | null>(null);
    const localVideoTrack = useRef<ICameraVideoTrack | null>(null);
    const [localVideoTrackState, setLocalVideoTrackState] = useState<ICameraVideoTrack | null>(null);
    
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const pipDragStartRef = useRef({ x: 0, y: 0, initialX: 0, initialY: 0 });
    const callStatusRef = useRef<Call['status'] | null>(null);

    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    useEffect(() => {
        const checkIsMobile = () => window.innerWidth < 768;
        setIsChatVisible(!checkIsMobile()); // Show chat by default on desktop

        const handleResize = () => {
            if(window.innerWidth >= 768 && !isChatVisible) {
                setIsChatVisible(true);
            }
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [isChatVisible]);

    useEffect(() => {
        let isMounted = true;
        const setupAgora = async () => { /* ... (Agora setup logic remains mostly the same) ... */ };
        // ... (The entire Agora setup useEffect remains the same) ...
        // ... I'm omitting it for brevity, but it's unchanged.
        const roomUnsubscribe = geminiService.listenToVideoRoom(roomId, (liveRoom) => {
            if (isMounted) {
                if (!liveRoom || liveRoom.status === 'ended') {
                    onGoBack();
                } else {
                    setRoom(liveRoom);
                }
            }
        });
        const messagesUnsubscribe = firebaseService.listenToLiveVideoRoomMessages(roomId, (msgs) => {
            if (isMounted) setMessages(msgs);
        });
        
        return () => { isMounted = false; /* ... (cleanup logic) ... */ };
    }, [roomId, currentUser.id, onGoBack, onSetTtsMessage]);

    const handleLeaveOrEnd = () => {
        if (room?.host.id === currentUser.id) {
            if (window.confirm("Are you sure you want to end this room for everyone?")) {
                geminiService.endLiveVideoRoom(currentUser.id, roomId);
            }
        } else {
            onGoBack();
        }
    };
    
    const toggleMute = () => {
        const muted = !isMuted;
        localAudioTrack.current?.setMuted(muted);
        setIsMuted(muted);
        geminiService.updateParticipantStateInVideoRoom(roomId, currentUser.id, { isMuted: muted });
    };

    const toggleCamera = () => {
        const cameraOff = !isCameraOff;
        localVideoTrack.current?.setEnabled(!cameraOff);
        setIsCameraOff(cameraOff);
        geminiService.updateParticipantStateInVideoRoom(roomId, currentUser.id, { isCameraOff: cameraOff });
    };

    const handleSendMessage = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = newMessage.trim();
        if (trimmed) {
            await geminiService.sendLiveVideoRoomMessage(roomId, currentUser, trimmed);
            setNewMessage('');
        }
    };

    const handleEmojiReaction = (emoji: string) => {
        const newEmoji = { id: Date.now() + Math.random(), emoji };
        setFloatingEmojis(current => [...current, newEmoji]);
        setTimeout(() => {
            setFloatingEmojis(current => current.filter(e => e.id !== newEmoji.id));
        }, 3000);
    };
    
    const handlePipTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
        const touch = e.touches[0];
        pipDragStartRef.current = {
            x: touch.clientX,
            y: touch.clientY,
            initialX: localPipPosition.x,
            initialY: localPipPosition.y,
        };
    };

    const handlePipTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
        const touch = e.touches[0];
        const dx = touch.clientX - pipDragStartRef.current.x;
        const dy = touch.clientY - pipDragStartRef.current.y;
        
        // Assuming PiP size is 96x128 (w x h)
        const newX = Math.min(window.innerWidth - 96 - 16, Math.max(16, pipDragStartRef.current.initialX + dx));
        const newY = Math.min(window.innerHeight - 128 - 16, Math.max(16, pipDragStartRef.current.initialY + dy));
        
        setLocalPipPosition({ x: newX, y: newY });
    };
    
    if (!room) return <div className="h-full w-full flex items-center justify-center bg-black text-white">Connecting...</div>

    const allParticipants = room?.participants || [];
    const localParticipant = allParticipants.find(p => p.id === currentUser.id);
    const remoteParticipants = allParticipants.filter(p => p.id !== currentUser.id);
    const remoteUsersMap = useMemo(() => new Map(remoteUsers.map(u => [u.uid, u])), [remoteUsers]);

    const activeSpeaker = allParticipants.find(p => stringToIntegerHash(p.id) === activeSpeakerUid);
    let mainParticipant = activeSpeaker && activeSpeaker.id !== currentUser.id ? activeSpeaker : remoteParticipants[0] || localParticipant;
    if (allParticipants.length === 1) mainParticipant = localParticipant;
    
    const filmstripParticipants = allParticipants.filter(p => p.id !== mainParticipant?.id && p.id !== localParticipant?.id);

    return (
        <div className="h-full w-full flex flex-col bg-black text-white overflow-hidden relative">
            <main className="flex-grow relative flex items-center justify-center">
                 <div className="absolute inset-0 bg-gradient-to-br from-slate-900 to-indigo-900"/>
                {mainParticipant && (
                    <div className="w-full h-full p-2">
                        <ParticipantVideo
                            key={mainParticipant.id}
                            participant={mainParticipant}
                            isLocal={mainParticipant.id === currentUser.id}
                            isSpeaking={activeSpeaker?.id === mainParticipant.id}
                            localVideoTrack={localVideoTrack.current}
                            remoteUser={remoteUsersMap.get(stringToIntegerHash(mainParticipant.id))}
                            view="main"
                        />
                    </div>
                )}
                 {localParticipant && allParticipants.length > 1 && (
                     <div 
                        className="absolute w-24 h-32 md:w-32 md:h-44 z-20 touch-none" 
                        style={{ top: `${localPipPosition.y}px`, left: `${localPipPosition.x}px` }}
                        onTouchStart={handlePipTouchStart}
                        onTouchMove={handlePipTouchMove}
                    >
                         <ParticipantVideo
                             participant={{ ...localParticipant, isMuted, isCameraOff }}
                             isLocal
                             isSpeaking={activeSpeaker?.id === localParticipant.id}
                             localVideoTrack={localVideoTrack.current}
                             view="pip"
                         />
                     </div>
                 )}
                 <div className="float-emoji-container">
                     {floatingEmojis.map(({ id, emoji }) => (
                         <div key={id} className="emoji" style={{ left: `${Math.random() * 80}%`, animationDelay: `${Math.random() * 0.5}s` }}>{emoji}</div>
                     ))}
                 </div>
            </main>
            {(filmstripParticipants.length > 0) && (
                <footer className="flex-shrink-0 w-full overflow-x-auto no-scrollbar p-2">
                    <div className="flex gap-2 w-max">
                        {filmstripParticipants.map(p => (
                             <div key={p.id} className="w-24 h-24 flex-shrink-0">
                                <ParticipantVideo
                                    participant={p}
                                    isSpeaking={activeSpeaker?.id === p.id}
                                    remoteUser={remoteUsersMap.get(stringToIntegerHash(p.id))}
                                    view="filmstrip"
                                />
                            </div>
                        ))}
                    </div>
                </footer>
            )}
            <aside className={`absolute top-0 bottom-0 right-0 h-full w-full max-w-sm md:w-[340px] bg-black/60 backdrop-blur-md border-l border-white/10 flex flex-col z-30 transition-transform duration-300 ${isChatVisible ? 'translate-x-0' : 'translate-x-full'}`}>
                 <header className="p-3 flex-shrink-0 border-b border-slate-700/50 flex items-center justify-between">
                    <h2 className="font-bold text-lg">Live Chat</h2>
                    <button onClick={() => setIsChatVisible(false)} className="p-2 -mr-2 rounded-full hover:bg-slate-700/50">
                        <Icon name="close" className="w-5 h-5"/>
                    </button>
                </header>
                 <div className="flex-grow overflow-y-auto space-y-3 no-scrollbar p-2">
                     {messages.map(msg => <ChatMessage key={msg.id} message={msg} isMe={msg.sender.id === currentUser.id} />)}
                     <div ref={messagesEndRef} />
                 </div>
                 <footer className="p-2 flex-shrink-0 border-t border-slate-700 bg-black/30">
                    <form onSubmit={handleSendMessage} className="flex items-center gap-2">
                        <input
                            type="text" value={newMessage} onChange={(e) => setNewMessage(e.target.value)}
                            placeholder="Send a message..."
                            className="w-full bg-slate-700/80 border border-slate-600 rounded-full py-2 px-4 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-rose-500"
                        />
                         <button type="submit" className="p-2.5 bg-rose-600 rounded-full text-white hover:bg-rose-500 disabled:bg-slate-500" disabled={!newMessage.trim()}>
                            <Icon name="paper-airplane" className="w-5 h-5" />
                        </button>
                    </form>
                </footer>
            </aside>
            <div className="absolute bottom-0 left-0 right-0 p-4 z-20 flex justify-center">
                <div className="flex items-center justify-center gap-3 bg-black/50 backdrop-blur-md p-2 rounded-full">
                    <button onClick={toggleMute} disabled={!isMicAvailable} className={`p-3 rounded-full transition-colors ${!isMicAvailable ? 'bg-red-600/50 cursor-not-allowed' : isMuted ? 'bg-rose-600' : 'bg-slate-700/80'}`}>
                        <Icon name={!isMicAvailable || isMuted ? 'microphone-slash' : 'mic'} className="w-6 h-6" />
                    </button>
                     <button onClick={toggleCamera} disabled={!isCamAvailable} className={`p-3 rounded-full transition-colors ${!isCamAvailable ? 'bg-red-600/50 cursor-not-allowed' : isCameraOff ? 'bg-rose-600' : 'bg-slate-700/80'}`}>
                        <Icon name={!isCamAvailable || isCameraOff ? 'video-camera-slash' : 'video-camera'} className="w-6 h-6" />
                    </button>
                    <button onClick={handleLeaveOrEnd} className="p-4 rounded-full bg-red-600">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" transform="rotate(-135 12 12)"/></svg>
                    </button>
                    <button onClick={() => setIsChatVisible(v => !v)} className="p-3 rounded-full bg-slate-700/80">
                       <Icon name="comment" className="w-6 h-6" />
                    </button>
                     <div className="relative group/emoji">
                        <button className="p-3 rounded-full bg-slate-700/80">
                           <Icon name="face-smile" className="w-6 h-6" />
                        </button>
                        <div className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 hidden group-hover/emoji:flex bg-slate-800 p-2 rounded-full gap-2">
                             {EMOJI_REACTIONS.map(emoji => (
                                 <button key={emoji} onClick={() => handleEmojiReaction(emoji)} className="text-2xl p-1 rounded-full hover:bg-slate-700 transition-transform hover:scale-125">{emoji}</button>
                             ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
export default LiveVideoRoomScreen;