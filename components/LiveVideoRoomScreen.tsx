import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { LiveVideoRoom, User, VideoParticipantState } from '../types';
import { geminiService } from '../services/geminiService';
import Icon from './Icon';
import { AGORA_APP_ID } from '../constants';
import AgoraRTC from 'agora-rtc-sdk-ng';
import type { IAgoraRTCClient, IAgoraRTCRemoteUser, IMicrophoneAudioTrack, ICameraVideoTrack } from 'agora-rtc-sdk-ng';

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
    isLocal: boolean;
    isSpeaking: boolean;
    localVideoTrack: ICameraVideoTrack | null;
    remoteUser: IAgoraRTCRemoteUser | undefined;
}> = ({ participant, isLocal, isSpeaking, localVideoTrack, remoteUser }) => {
    const videoRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const videoContainer = videoRef.current;
        if (!videoContainer) return;

        let trackToPlay: ICameraVideoTrack | undefined | null = isLocal ? localVideoTrack : remoteUser?.videoTrack;
        
        // Ensure the track is played only if the camera is not off
        if (trackToPlay && !participant.isCameraOff) {
            if (!trackToPlay.isPlaying) {
                 trackToPlay.play(videoContainer, { fit: 'cover' });
            }
        } else {
            // If there's a track playing, stop it because camera is off
            const playingTrack = isLocal ? localVideoTrack : remoteUser?.videoTrack;
            if (playingTrack && playingTrack.isPlaying) {
                playingTrack.stop();
            }
        }
    }, [isLocal, localVideoTrack, remoteUser, participant.isCameraOff]);
    
    const showVideo = (isLocal && localVideoTrack && !participant.isCameraOff) || (!isLocal && remoteUser?.hasVideo && !participant.isCameraOff);

    return (
        <div className="w-full h-full bg-slate-800 relative group animate-fade-in-fast">
            {showVideo ? (
                <div ref={videoRef} className={`w-full h-full ${isLocal ? 'transform scale-x-[-1]' : ''}`} />
            ) : (
                <div className="w-full h-full flex items-center justify-center">
                    <img src={participant.avatarUrl} alt={participant.name} className="w-24 h-24 object-cover rounded-full opacity-50" />
                </div>
            )}
             <div className={`absolute inset-0 border-4 rounded-lg pointer-events-none transition-all duration-300 ${isSpeaking ? 'border-green-400 ring-4 ring-green-500/50' : 'border-transparent'}`} />
             <div className="absolute bottom-0 left-0 right-0 p-3 bg-gradient-to-t from-black/70 to-transparent">
                 <div className="flex items-center gap-2">
                    {participant.isMuted && <Icon name="microphone-slash" className="w-4 h-4 text-white bg-red-600 p-1 rounded-full"/>}
                    <p className="font-semibold text-white truncate text-shadow-lg">{participant.name}</p>
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

const getGridLayout = (participantCount: number) => {
    if (participantCount <= 1) return 'grid-cols-1 grid-rows-1';
    if (participantCount === 2) return 'grid-cols-1 grid-rows-2 md:grid-cols-2 md:grid-rows-1';
    if (participantCount <= 4) return 'grid-cols-2 grid-rows-2';
    if (participantCount <= 6) return 'grid-cols-2 grid-rows-3 md:grid-cols-3 md:grid-rows-2';
    if (participantCount <= 9) return 'grid-cols-3 grid-rows-3';
    return 'grid-cols-3 grid-rows-3'; 
};


const LiveVideoRoomScreen: React.FC<LiveVideoRoomScreenProps> = ({ currentUser, roomId, onGoBack, onSetTtsMessage }) => {
    const [room, setRoom] = useState<LiveVideoRoom | null>(null);
    const [remoteUsers, setRemoteUsers] = useState<IAgoraRTCRemoteUser[]>([]);
    const [isMuted, setIsMuted] = useState(false);
    const [isCameraOff, setIsCameraOff] = useState(false);
    const [isMicAvailable, setIsMicAvailable] = useState(true);
    const [isCamAvailable, setIsCamAvailable] = useState(true);
    const [activeSpeakerUid, setActiveSpeakerUid] = useState<number | null>(null);

    const agoraClient = useRef<IAgoraRTCClient | null>(null);
    const localAudioTrack = useRef<IMicrophoneAudioTrack | null>(null);
    const localVideoTrack = useRef<ICameraVideoTrack | null>(null);
    
    const roomRef = useRef(room);
    roomRef.current = room;

    useEffect(() => {
        let isMounted = true;

        const setupAgora = async () => {
            if (!AGORA_APP_ID) throw new Error("Agora App ID is not configured.");

            const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
            agoraClient.current = client;

            client.on('user-published', async (user, mediaType) => {
                await client.subscribe(user, mediaType);
                if (isMounted) setRemoteUsers(Array.from(client.remoteUsers));
                if (mediaType === 'audio') user.audioTrack?.play();
            });

            client.on('user-left', () => { if (isMounted) setRemoteUsers(Array.from(client.remoteUsers)); });
            client.on('user-unpublished', () => { if (isMounted) setRemoteUsers(Array.from(client.remoteUsers)); });

            client.enableAudioVolumeIndicator();
            client.on('volume-indicator', (volumes) => {
                const mainSpeaker = volumes.reduce((max, current) => current.level > max.level ? current : max, { level: 0, uid: 0 });
                if (isMounted) setActiveSpeakerUid(mainSpeaker.level > 5 ? mainSpeaker.uid : null);
            });
            
            const uid = stringToIntegerHash(currentUser.id);
            const token = await geminiService.getAgoraToken(roomId, uid);
            if (!token) throw new Error("Failed to retrieve Agora token.");

            await client.join(AGORA_APP_ID, roomId, token, uid);

            const tracksToPublish: (IMicrophoneAudioTrack | ICameraVideoTrack)[] = [];
            try {
                const audioTrack = await AgoraRTC.createMicrophoneAudioTrack();
                localAudioTrack.current = audioTrack;
                tracksToPublish.push(audioTrack);
                if (isMounted) setIsMicAvailable(true);
            } catch (e) { 
                console.warn("Could not get mic", e); 
                if (isMounted) {
                    setIsMicAvailable(false);
                    setIsMuted(true);
                    geminiService.updateParticipantStateInVideoRoom(roomId, currentUser.id, { isMuted: true });
                }
            }

            try {
                const videoTrack = await AgoraRTC.createCameraVideoTrack();
                localVideoTrack.current = videoTrack;
                tracksToPublish.push(videoTrack);
                if (isMounted) setIsCamAvailable(true);
            } catch (e) { 
                console.warn("Could not get cam", e); 
                if (isMounted) {
                    setIsCamAvailable(false);
                    setIsCameraOff(true);
                    geminiService.updateParticipantStateInVideoRoom(roomId, currentUser.id, { isCameraOff: true });
                }
            }

            if (tracksToPublish.length > 0) {
                await client.publish(tracksToPublish);
            }
        };

        const initialize = async () => {
            await geminiService.joinLiveVideoRoom(currentUser.id, roomId);
            await setupAgora();
        };
        
        initialize().catch(err => {
            console.error("Agora setup failed:", err);
            onSetTtsMessage("Could not start call. Check device permissions.");
            onGoBack();
        });

        const roomUnsubscribe = geminiService.listenToVideoRoom(roomId, (liveRoom) => {
            if (isMounted) {
                if (!liveRoom || liveRoom.status === 'ended') {
                    onGoBack();
                } else {
                    setRoom(liveRoom);
                }
            }
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

    const handleLeaveOrEnd = () => {
        if (roomRef.current?.host.id === currentUser.id) {
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

    const allParticipants = room?.participants || [];
    const gridLayout = getGridLayout(allParticipants.length);
    const remoteUsersMap = useMemo(() => new Map(remoteUsers.map(u => [u.uid, u])), [remoteUsers]);

    if (!room) return <div className="h-full w-full flex items-center justify-center bg-black text-white">Connecting...</div>;

    return (
        <div className="h-full w-full flex flex-col bg-black text-white overflow-hidden relative">
            <header className="absolute top-0 left-0 right-0 p-4 z-20 bg-gradient-to-b from-black/50 to-transparent flex justify-between items-center">
                <div className="flex items-center gap-3">
                    <Icon name="logo" className="w-8 h-8 text-lime-400"/>
                    <div>
                        <h1 className="font-bold text-lg truncate text-shadow-lg">{room.topic}</h1>
                        <p className="text-xs text-slate-300 text-shadow-lg">{allParticipants.length} participant(s)</p>
                    </div>
                </div>
            </header>
            
            <main className={`w-full h-full grid ${gridLayout} gap-1 p-1`}>
                {allParticipants.slice(0, 9).map(p => {
                    const isLocal = p.id === currentUser.id;
                    const agoraUid = stringToIntegerHash(p.id);
                    const agoraUser = isLocal ? undefined : remoteUsersMap.get(agoraUid);
                    const participantState = isLocal ? { ...p, isMuted, isCameraOff } : p;
                    const isSpeaking = (isLocal && activeSpeakerUid === 0) || (!isLocal && agoraUser && activeSpeakerUid === agoraUser.uid);

                    return (
                        <div key={p.id} className="relative rounded-lg overflow-hidden">
                            <ParticipantVideo
                                participant={participantState}
                                isLocal={isLocal}
                                isSpeaking={isSpeaking}
                                localVideoTrack={localVideoTrack.current}
                                remoteUser={agoraUser}
                            />
                        </div>
                    );
                })}
            </main>
           
            <footer className="absolute bottom-0 left-0 right-0 p-4 z-20 flex justify-center">
                 <div className="bg-black/40 backdrop-blur-md rounded-full flex items-center gap-4 p-3 border border-slate-700">
                    <button 
                        onClick={toggleMute} 
                        disabled={!isMicAvailable}
                        className={`p-4 rounded-full transition-colors ${!isMicAvailable ? 'bg-red-600/50 cursor-not-allowed' : isMuted ? 'bg-rose-600' : 'bg-slate-700'}`}
                        aria-label={isMuted ? 'Unmute' : 'Mute'}
                    >
                        <Icon name={!isMicAvailable || isMuted ? 'microphone-slash' : 'mic'} className="w-6 h-6" />
                    </button>
                    <button 
                        onClick={toggleCamera} 
                        disabled={!isCamAvailable}
                        className={`p-4 rounded-full transition-colors ${!isCamAvailable ? 'bg-red-600/50 cursor-not-allowed' : isCameraOff ? 'bg-rose-600' : 'bg-slate-700'}`}
                        aria-label={isCameraOff ? 'Turn camera on' : 'Turn camera off'}
                    >
                        <Icon name={!isCamAvailable || isCameraOff ? 'video-camera-slash' : 'video-camera'} className="w-6 h-6" />
                    </button>
                    <button onClick={handleLeaveOrEnd} className="p-4 rounded-full bg-red-600" aria-label="End call">
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" transform="rotate(-135 12 12)"/></svg>
                    </button>
                </div>
            </footer>
        </div>
    );
};

export default LiveVideoRoomScreen;