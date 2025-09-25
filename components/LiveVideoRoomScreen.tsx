import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { LiveVideoRoom, User, VideoParticipantState } from '../types';
import { geminiService } from '../services/geminiService';
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
    hash |= 0;
  }
  return Math.abs(hash);
}

const ParticipantVideo: React.FC<{
    participant: VideoParticipantState;
    isLocal?: boolean;
    isSpeaking: boolean;
    localVideoTrack?: ICameraVideoTrack | null;
    remoteUser?: IAgoraRTCRemoteUser | undefined;
    view: 'grid' | 'filmstrip' | 'pip' | 'main';
    onClick?: () => void;
}> = ({ participant, isLocal, isSpeaking, localVideoTrack, remoteUser, view, onClick }) => {
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
            if (playingTrack?.isPlaying) {
                playingTrack.stop();
            }
        }
    }, [isLocal, localVideoTrack, remoteUser, participant.isCameraOff]);
    
    const showVideo = (isLocal && localVideoTrack && !participant.isCameraOff) || (!isLocal && remoteUser?.hasVideo && !participant.isCameraOff);
    
    const containerClasses = useMemo(() => {
        const base = "w-full h-full bg-slate-800 relative group rounded-lg overflow-hidden transition-all duration-300";
        if (view === 'filmstrip') return `${base} cursor-pointer`;
        return base;
    }, [view]);

    return (
        <div 
            className={containerClasses} 
            onClick={onClick}
        >
            {showVideo ? (
                <div ref={videoRef} className={`w-full h-full ${isLocal ? 'transform scale-x-[-1]' : ''}`} />
            ) : (
                <div className="w-full h-full flex items-center justify-center">
                    <img src={participant.avatarUrl} alt={participant.name} className={`object-cover rounded-full opacity-50 ${view === 'main' || view === 'grid' ? 'w-24 h-24' : 'w-14 h-14'}`} />
                </div>
            )}
             <div className={`absolute inset-0 rounded-lg pointer-events-none transition-all duration-300 ${isSpeaking ? 'animate-pulse-glow' : 'border-2 border-transparent'}`} />
             <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black/60 to-transparent flex items-center gap-2">
                 <p className="font-semibold text-white truncate text-shadow-lg text-sm">{participant.name}</p>
                 {participant.isMuted && <Icon name="microphone-slash" className="w-4 h-4 text-white flex-shrink-0" />}
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
    const [remoteUsers, setRemoteUsers] = useState<IAgoraRTCRemoteUser[]>([]);
    const [isMuted, setIsMuted] = useState(false);
    const [isCameraOff, setIsCameraOff] = useState(false);
    const [isMicAvailable, setIsMicAvailable] = useState(true);
    const [isCamAvailable, setIsCamAvailable] = useState(true);
    const [activeSpeakerUid, setActiveSpeakerUid] = useState<number | null>(null);
    const [floatingEmojis, setFloatingEmojis] = useState<{id: number; emoji: string}[]>([]);
    const [localPipPosition, setLocalPipPosition] = useState({ x: 16, y: 16 });
    const [pinnedUserId, setPinnedUserId] = useState<string | null>(null);

    const agoraClient = useRef<IAgoraRTCClient | null>(null);
    const localAudioTrack = useRef<IMicrophoneAudioTrack | null>(null);
    const localVideoTrack = useRef<ICameraVideoTrack | null>(null);
    const [localVideoTrackState, setLocalVideoTrackState] = useState<ICameraVideoTrack | null>(null);
    
    const pipDragStartRef = useRef({ x: 0, y: 0, initialX: 0, initialY: 0 });

    const remoteUsersMap = useMemo(() => new Map(remoteUsers.map(u => [u.uid, u])), [remoteUsers]);

    useEffect(() => {
        let isMounted = true;

        const setupAgora = async () => {
            const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
            agoraClient.current = client;

            client.on('user-published', async (user, mediaType) => {
                await client.subscribe(user, mediaType);
                if (isMounted) setRemoteUsers(prev => [...prev.filter(u => u.uid !== user.uid), user]);
                if (mediaType === 'audio') user.audioTrack?.play();
            });

            client.on('user-left', (user) => {
                if (isMounted) setRemoteUsers(prev => prev.filter(u => u.uid !== user.uid));
            });

            client.enableAudioVolumeIndicator();
            client.on('volume-indicator', (volumes) => {
                if (volumes.length > 0) {
                    const mainSpeaker = volumes.reduce((max, current) => current.level > max.level ? current : max);
                    if (mainSpeaker.level > 5) setActiveSpeakerUid(mainSpeaker.uid as number);
                    else setActiveSpeakerUid(null);
                } else {
                    setActiveSpeakerUid(null);
                }
            });

            const uid = stringToIntegerHash(currentUser.id);
            const token = await geminiService.getAgoraToken(roomId, uid);
            if (!token) throw new Error("Failed to get token.");
            await client.join(AGORA_APP_ID, roomId, token, uid);

            let audioTrack: IMicrophoneAudioTrack | null = null;
            let videoTrack: ICameraVideoTrack | null = null;

            try {
                audioTrack = await AgoraRTC.createMicrophoneAudioTrack();
                localAudioTrack.current = audioTrack;
                setIsMicAvailable(true);
            } catch { setIsMicAvailable(false); setIsMuted(true); }

            try {
                videoTrack = await AgoraRTC.createCameraVideoTrack();
                localVideoTrack.current = videoTrack;
                setLocalVideoTrackState(videoTrack);
                setIsCamAvailable(true);
            } catch { setIsCamAvailable(false); setIsCameraOff(true); }

            const tracksToPublish = [audioTrack, videoTrack].filter(Boolean) as (IMicrophoneAudioTrack | ICameraVideoTrack)[];
            if (tracksToPublish.length > 0) await client.publish(tracksToPublish);
        };

        const roomUnsubscribe = geminiService.listenToVideoRoom(roomId, (liveRoom) => {
            if (isMounted) {
                if (!liveRoom || liveRoom.status === 'ended') onGoBack();
                else setRoom(liveRoom as LiveVideoRoom);
            }
        });

        geminiService.joinLiveVideoRoom(currentUser.id, roomId)
            .then(setupAgora)
            .catch(err => {
                onSetTtsMessage(`Error joining room: ${err.message}`);
                onGoBack();
            });

        return () => { 
            isMounted = false;
            localAudioTrack.current?.stop();
            localAudioTrack.current?.close();
            localVideoTrack.current?.stop();
            localVideoTrack.current?.close();
            agoraClient.current?.leave();
            geminiService.leaveLiveVideoRoom(currentUser.id, roomId);
            roomUnsubscribe();
        };
    }, [roomId, currentUser.id, onGoBack, onSetTtsMessage]);

    const handleHangUp = () => {
        if (room?.host.id === currentUser.id) {
            if (window.confirm("End this room for everyone?")) geminiService.endLiveVideoRoom(currentUser.id, roomId);
        } else onGoBack();
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

    const handleEmojiReaction = (emoji: string) => {
        const newEmoji = { id: Date.now() + Math.random(), emoji };
        setFloatingEmojis(current => [...current.slice(-19), newEmoji]);
    };
    
    const handlePipTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
        const touch = e.touches[0];
        pipDragStartRef.current = { x: touch.clientX, y: touch.clientY, initialX: localPipPosition.x, initialY: localPipPosition.y };
    };

    const handlePipTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
        const touch = e.touches[0];
        const dx = touch.clientX - pipDragStartRef.current.x;
        const dy = touch.clientY - pipDragStartRef.current.y;
        const newX = Math.min(window.innerWidth - 96 - 16, Math.max(16, pipDragStartRef.current.initialX + dx));
        const newY = Math.min(window.innerHeight - 128 - 80, Math.max(16, pipDragStartRef.current.initialY + dy));
        setLocalPipPosition({ x: newX, y: newY });
    };
    
    if (!room) return <div className="h-full w-full flex items-center justify-center bg-black text-white">Connecting...</div>

    const allParticipants = room.participants || [];
    const localParticipant = allParticipants.find(p => p.id === currentUser.id);
    
    const activeSpeaker = allParticipants.find(p => stringToIntegerHash(p.id) === activeSpeakerUid);
    const pinnedParticipant = allParticipants.find(p => p.id === pinnedUserId);

    // Determine the main participant for mobile view
    const mainMobileParticipant = pinnedParticipant || activeSpeaker || allParticipants.find(p => p.id !== currentUser.id) || localParticipant;
    
    const gridLayoutClasses = useMemo(() => {
        const count = allParticipants.length;
        if (count <= 1) return 'grid-cols-1';
        if (count === 2) return 'grid-cols-2';
        if (count <= 4) return 'grid-cols-2';
        if (count <= 6) return 'grid-cols-3';
        return 'grid-cols-3';
    }, [allParticipants.length]);

    return (
        <div className="h-full w-full flex flex-col bg-black text-white overflow-hidden relative">
            {/* Desktop Grid View */}
            <main className={`hidden md:grid flex-grow p-4 gap-4 ${gridLayoutClasses} items-center justify-center`}>
                {allParticipants.map(p => (
                    <div key={p.id} className="aspect-video">
                        <ParticipantVideo
                            participant={p.id === currentUser.id ? { ...p, isMuted, isCameraOff } : p}
                            isLocal={p.id === currentUser.id}
                            isSpeaking={activeSpeaker?.id === p.id}
                            localVideoTrack={localVideoTrackState}
                            remoteUser={remoteUsersMap.get(stringToIntegerHash(p.id))}
                            view="grid"
                        />
                    </div>
                ))}
            </main>

            {/* Mobile Main + Filmstrip View */}
            <main className="md:hidden flex-grow relative flex flex-col items-center justify-center">
                <div className="w-full flex-grow relative">
                    {mainMobileParticipant && (
                        <ParticipantVideo
                            participant={mainMobileParticipant.id === currentUser.id ? { ...mainMobileParticipant, isMuted, isCameraOff } : mainMobileParticipant}
                            isLocal={mainMobileParticipant.id === currentUser.id}
                            isSpeaking={activeSpeaker?.id === mainMobileParticipant.id}
                            localVideoTrack={localVideoTrackState}
                            remoteUser={remoteUsersMap.get(stringToIntegerHash(mainMobileParticipant.id))}
                            view="main"
                        />
                    )}
                </div>
                 {localParticipant && mainMobileParticipant?.id !== localParticipant.id && (
                     <div 
                        className="absolute w-24 h-32 z-20 touch-none" 
                        style={{ top: `${localPipPosition.y}px`, left: `${localPipPosition.x}px` }}
                        onTouchStart={handlePipTouchStart}
                        onTouchMove={handlePipTouchMove}
                    >
                         <ParticipantVideo
                             participant={{ ...localParticipant, isMuted, isCameraOff }}
                             isLocal
                             isSpeaking={activeSpeaker?.id === localParticipant.id}
                             localVideoTrack={localVideoTrackState}
                             view="pip"
                             onClick={() => setPinnedUserId(currentUser.id === pinnedUserId ? null : currentUser.id)}
                         />
                     </div>
                 )}
                 <div className="flex-shrink-0 w-full overflow-x-auto no-scrollbar p-2">
                    <div className="flex gap-2 w-max">
                        {allParticipants.filter(p => p.id !== mainMobileParticipant?.id).map(p => (
                             <div key={p.id} className="w-24 h-24 flex-shrink-0">
                                <ParticipantVideo
                                    participant={p.id === currentUser.id ? { ...p, isMuted, isCameraOff } : p}
                                    isLocal={p.id === currentUser.id}
                                    isSpeaking={activeSpeaker?.id === p.id}
                                    remoteUser={remoteUsersMap.get(stringToIntegerHash(p.id))}
                                    localVideoTrack={localVideoTrackState}
                                    view="filmstrip"
                                    onClick={() => setPinnedUserId(p.id === pinnedUserId ? null : p.id)}
                                />
                            </div>
                        ))}
                    </div>
                </div>
            </main>
            
            <div className="float-emoji-container">
                {floatingEmojis.map(({ id, emoji }) => <div key={id} className="emoji" style={{ left: `${Math.random() * 80}%`, animationDelay: `${Math.random() * 0.5}s` }}>{emoji}</div>)}
            </div>
            
            <div className="absolute bottom-0 left-0 right-0 p-4 z-20 flex justify-center">
                <div className="flex items-center justify-center gap-3 bg-black/50 backdrop-blur-md p-2 rounded-full">
                    <button onClick={toggleMute} disabled={!isMicAvailable} className={`p-3 rounded-full transition-colors ${!isMicAvailable ? 'bg-red-600/50 cursor-not-allowed' : isMuted ? 'bg-rose-600' : 'bg-slate-700/80'}`}>
                        <Icon name={!isMicAvailable || isMuted ? 'microphone-slash' : 'mic'} className="w-6 h-6" />
                    </button>
                    <button onClick={toggleCamera} disabled={!isCamAvailable} className={`p-3 rounded-full transition-colors ${!isCamAvailable ? 'bg-red-600/50 cursor-not-allowed' : isCameraOff ? 'bg-rose-600' : 'bg-slate-700/80'}`}>
                        <Icon name={!isCamAvailable || isCameraOff ? 'video-camera-slash' : 'video-camera'} className="w-6 h-6" />
                    </button>
                    <button onClick={handleHangUp} className="p-4 rounded-full bg-red-600">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" transform="rotate(-135 12 12)"/></svg>
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