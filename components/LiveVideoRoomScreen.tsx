import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { LiveVideoRoom, User, VideoParticipantState, Call } from '../types';
import { geminiService } from '../services/geminiService';
import Icon from './Icon';
import { AGORA_APP_ID } from '../constants';
import AgoraRTC from 'agora-rtc-sdk-ng';
import type { IAgoraRTCClient, IAgoraRTCRemoteUser, IMicrophoneAudioTrack, ICameraVideoTrack } from 'agora-rtc-sdk-ng';
import { useSettings } from '../contexts/SettingsContext';

interface LiveVideoRoomScreenProps {
  currentUser: User;
  roomId: string;
  onGoBack: () => void;
  onSetTtsMessage: (message: string) => void;
}

// Mock Chat Messages for UI demonstration
const mockChat = [
    { id: 1, name: 'Sabbir', message: ' দারুণ লাইভ! 👍' },
    { id: 2, name: 'Nusrat', message: ' চালিয়ে যান ভাই!' },
    { id: 3, name: 'Riyad_Official', message: 'Hello from Dhaka!' },
    { id: 4, name: 'Priya', message: '❤️❤️❤️' },
    { id: 5, name: 'Aakash', message: 'Awesome content!' },
    { id: 6, name: 'Sumaiya', message: 'Very informative.' },
];

function stringToIntegerHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32bit integer
  }
  // Ensure it's a positive integer, as required by Agora for UIDs.
  return Math.abs(hash);
}

const ParticipantVideo: React.FC<{
    layout: 'main' | 'guest';
    participant: VideoParticipantState;
    isLocal: boolean;
    isSpeaking: boolean;
    localVideoTrack: ICameraVideoTrack | null;
    remoteUser: IAgoraRTCRemoteUser | undefined;
}> = ({ layout, participant, isLocal, isSpeaking, localVideoTrack, remoteUser }) => {
    const videoRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const videoContainer = videoRef.current;
        if (!videoContainer) return;

        let trackToPlay: ICameraVideoTrack | undefined | null = isLocal ? localVideoTrack : remoteUser?.videoTrack;
        
        if (trackToPlay && !participant.isCameraOff) {
            trackToPlay.play(videoContainer);
        } else {
            trackToPlay?.stop();
        }

        return () => trackToPlay?.stop();
    }, [isLocal, localVideoTrack, remoteUser, participant.isCameraOff]);

    const showVideo = (isLocal && localVideoTrack && !participant.isCameraOff) || (!isLocal && remoteUser?.hasVideo && !participant.isCameraOff);

    if (layout === 'main') {
        return (
            <div className="w-full h-full bg-slate-800">
                {showVideo ? (
                    <div ref={videoRef} className={`w-full h-full ${isLocal ? 'transform scale-x-[-1]' : ''}`} />
                ) : (
                    <img src={participant.avatarUrl} alt={participant.name} className="w-full h-full object-cover opacity-30 blur-sm" />
                )}
            </div>
        );
    }

    // Guest layout
    return (
        <div className="w-24 h-32 rounded-lg overflow-hidden bg-slate-800 relative shadow-md flex-shrink-0">
            {showVideo ? (
                <div ref={videoRef} className={`w-full h-full ${isLocal ? 'transform scale-x-[-1]' : ''}`} />
            ) : (
                <img src={participant.avatarUrl} alt={participant.name} className="w-full h-full object-cover opacity-50" />
            )}
            <div className={`absolute inset-0 border-2 rounded-lg pointer-events-none transition-colors ${isSpeaking ? 'border-green-400' : 'border-transparent'}`} />
            <p className="absolute bottom-1 left-1 text-xs font-semibold bg-black/40 px-1 rounded truncate">{isLocal ? 'You' : participant.name.split(' ')[0]}</p>
        </div>
    );
};


// Main Component
const LiveVideoRoomScreen: React.FC<LiveVideoRoomScreenProps> = ({ currentUser, roomId, onGoBack, onSetTtsMessage }) => {
    const [room, setRoom] = useState<LiveVideoRoom | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [remoteUsers, setRemoteUsers] = useState<IAgoraRTCRemoteUser[]>([]);
    const [isMuted, setIsMuted] = useState(false);
    const [isCameraOff, setIsCameraOff] = useState(false);
    const [isMicAvailable, setIsMicAvailable] = useState(true);
    const [isCamAvailable, setIsCamAvailable] = useState(true);
    const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);

    const agoraClient = useRef<IAgoraRTCClient | null>(null);
    const localAudioTrack = useRef<IMicrophoneAudioTrack | null>(null);
    const localVideoTrack = useRef<ICameraVideoTrack | null>(null);
    const [localVideoTrackState, setLocalVideoTrackState] = useState<ICameraVideoTrack | null>(null);
    const callStatusRef = useRef<Call['status'] | null>(null);

    const handleHangUp = useCallback(() => {
        geminiService.endLiveVideoRoom(currentUser.id, roomId);
    }, [currentUser.id, roomId]);
    
    // Agora Lifecycle
    useEffect(() => {
        let isMounted = true;
        if (!AGORA_APP_ID) {
            onSetTtsMessage("Agora App ID is not configured.");
            onGoBack();
            return;
        }

        const client = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
        agoraClient.current = client;

        const setupAgora = async () => {
            client.on('user-published', async (user, mediaType) => {
                await client.subscribe(user, mediaType);
                if (isMounted) setRemoteUsers(Array.from(client.remoteUsers));
                if (mediaType === 'audio') user.audioTrack?.play();
            });
            client.on('user-left', () => { if(isMounted) setRemoteUsers(Array.from(client.remoteUsers)); });
            client.on('user-unpublished', () => { if(isMounted) setRemoteUsers(Array.from(client.remoteUsers)); });
            client.enableAudioVolumeIndicator();
            client.on('volume-indicator', (volumes) => {
                const mainSpeaker = volumes.reduce((max, current) => current.level > max.level ? current : max, { level: 0 });
                if (isMounted) setActiveSpeakerId(mainSpeaker.level > 5 ? String(mainSpeaker.uid) : null);
            });

            const uid = stringToIntegerHash(currentUser.id);
            const token = await geminiService.getAgoraToken(roomId, uid);
            if (!token) throw new Error("Failed to retrieve Agora token.");
            await client.join(AGORA_APP_ID, roomId, token, uid);

            let audioTrack: IMicrophoneAudioTrack | null = null;
            let videoTrack: ICameraVideoTrack | null = null;
            
            try {
                audioTrack = await AgoraRTC.createMicrophoneAudioTrack();
                if (!isMounted) { audioTrack.close(); return; }
                localAudioTrack.current = audioTrack;
                setIsMicAvailable(true);
            } catch (e) {
                console.warn("Could not get microphone track:", e);
                if (!isMounted) return;
                setIsMicAvailable(false);
                setIsMuted(true);
            }

            try {
                videoTrack = await AgoraRTC.createCameraVideoTrack();
                if (!isMounted) { videoTrack.close(); audioTrack?.close(); return; }
                localVideoTrack.current = videoTrack;
                setLocalVideoTrackState(videoTrack);
                setIsCamAvailable(true);
            } catch (e) {
                console.warn("Could not get camera track:", e);
                if (!isMounted) { audioTrack?.close(); return; }
                setIsCamAvailable(false);
                setIsCameraOff(true);
            }

            const tracksToPublish = [audioTrack, videoTrack].filter(t => t !== null) as (IMicrophoneAudioTrack | ICameraVideoTrack)[];
            if (tracksToPublish.length > 0) {
                await client.publish(tracksToPublish);
            }
        };

        geminiService.joinLiveVideoRoom(currentUser.id, roomId).then(() => {
            if (isMounted) setupAgora().catch(err => {
                console.error("Agora setup failed:", err);
                onSetTtsMessage("Could not start call. Check device permissions.");
                onGoBack();
            });
        });

        return () => {
            isMounted = false;
            localAudioTrack.current?.stop();
            localAudioTrack.current?.close();
            localVideoTrack.current?.stop();
            localVideoTrack.current?.close();
            agoraClient.current?.leave();
            geminiService.leaveLiveVideoRoom(currentUser.id, roomId);
        };
    }, [roomId, currentUser.id, onGoBack, onSetTtsMessage]);

    // Firestore real-time listener for Room Metadata
    useEffect(() => {
        const unsubscribe = geminiService.listenToVideoRoom(roomId, (roomDetails) => {
            if (roomDetails) {
                setRoom(roomDetails);
                 callStatusRef.current = roomDetails?.status || null;
                if (!roomDetails || ['ended', 'declined', 'missed'].includes(roomDetails.status)) {
                    setTimeout(() => {
                        if (callStatusRef.current !== 'active' && callStatusRef.current !== 'ringing') {
                            onGoBack();
                        }
                    }, 2000);
                }
            } else {
                onGoBack();
            }
            setIsLoading(false);
        });
        return () => unsubscribe();
    }, [roomId, onGoBack]);

    const toggleMute = () => {
        if (!isMicAvailable) return;
        const muted = !isMuted;
        localAudioTrack.current?.setMuted(muted);
        setIsMuted(muted);
    };

    const toggleCamera = () => {
        if (!isCamAvailable) return;
        const cameraOff = !isCameraOff;
        localVideoTrack.current?.setEnabled(!cameraOff);
        setIsCameraOff(cameraOff);
    };

    const participantIdMap = useMemo(() => {
        if (!room) return new Map<string, string>();
        const map = new Map<string, string>();
        room.participants.forEach(p => {
            const agoraUID = String(stringToIntegerHash(p.id));
            map.set(agoraUID, p.id);
        });
        return map;
    }, [room]);
    
    const activeFirebaseSpeakerId = activeSpeakerId ? participantIdMap.get(activeSpeakerId) : null;
    
    const remoteUsersMap = useMemo(() => {
        const map = new Map<string, IAgoraRTCRemoteUser>();
        remoteUsers.forEach(u => map.set(String(u.uid), u));
        return map;
    }, [remoteUsers]);
    
    if (isLoading || !room) {
        return <div className="h-full w-full flex items-center justify-center bg-black text-white">Connecting...</div>;
    }

    const selfState = { ...currentUser, isMuted, isCameraOff };
    const host = room.participants.find(p => p.id === room.host.id) || room.host;
    const selfIsHost = currentUser.id === host.id;
    const guests = room.participants.filter(p => p.id !== host.id);
    
    const mainParticipant = selfIsHost ? selfState : host;
    const mainIsLocal = selfIsHost;
    const hostAgoraUid = String(stringToIntegerHash(host.id));
    const mainRemoteUser = selfIsHost ? undefined : remoteUsersMap.get(hostAgoraUid);

    return (
        <div className="relative h-full w-full bg-black text-white overflow-hidden">
            {/* Background Video (Host or Self if host) */}
            <div className="absolute inset-0">
                <ParticipantVideo
                    layout="main"
                    participant={mainParticipant}
                    isLocal={mainIsLocal}
                    isSpeaking={activeFirebaseSpeakerId === mainParticipant.id}
                    localVideoTrack={localVideoTrackState}
                    remoteUser={mainRemoteUser}
                />
            </div>
            <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/60" />

            {/* Top Bar */}
            <header className="absolute top-0 left-0 right-0 p-4 flex justify-between items-start z-20">
                <div className="flex items-center gap-2 bg-black/40 p-1.5 pr-3 rounded-full backdrop-blur-sm">
                    <img src={host.avatarUrl} alt={host.name} className="w-10 h-10 rounded-full" />
                    <div>
                        <h1 className="font-bold text-sm">{host.name}</h1>
                        <p className="text-xs text-slate-300">{room.participants.length} viewers</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                     <button onClick={onGoBack} className="w-8 h-8 bg-black/40 rounded-full flex items-center justify-center backdrop-blur-sm">
                        <Icon name="close" className="w-5 h-5"/>
                    </button>
                </div>
            </header>

            {/* Guests Video List */}
            <div className="absolute top-20 right-4 w-28 space-y-2 z-10 flex flex-col">
                {guests.map(guest => {
                    const guestAgoraUid = String(stringToIntegerHash(guest.id));
                    const remoteUserForGuest = remoteUsersMap.get(guestAgoraUid);
                     return (
                        <ParticipantVideo
                            key={guest.id}
                            layout="guest"
                            participant={guest}
                            isLocal={guest.id === currentUser.id}
                            isSpeaking={activeFirebaseSpeakerId === guest.id}
                            localVideoTrack={localVideoTrackState}
                            remoteUser={remoteUserForGuest}
                        />
                    );
                })}
            </div>

            {/* Bottom Section */}
            <footer className="absolute bottom-0 left-0 right-0 p-4 z-20">
                <div className="w-full max-w-sm h-40 overflow-y-auto mb-3 no-scrollbar" style={{textShadow: '0 1px 3px rgba(0,0,0,0.5)'}}>
                    {mockChat.map(chat => (
                        <div key={chat.id} className="p-1 mb-1">
                            <span className="font-bold text-sky-300 text-sm">{chat.name}: </span>
                            <span className="text-white text-sm">{chat.message}</span>
                        </div>
                    ))}
                </div>
                <div className="flex items-center gap-3">
                    <input type="text" placeholder="Add a comment..." className="flex-grow bg-black/40 border border-slate-600 rounded-full py-2.5 px-4 text-white placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-rose-500 backdrop-blur-sm"/>
                    <button onClick={toggleMute} disabled={!isMicAvailable} className={`w-12 h-12 rounded-full flex items-center justify-center backdrop-blur-sm transition-colors ${!isMicAvailable ? 'bg-red-600/50 cursor-not-allowed' : isMuted ? 'bg-rose-600' : 'bg-black/40'}`}>
                        <Icon name={!isMicAvailable || isMuted ? 'microphone-slash' : 'mic'} className="w-6 h-6" />
                    </button>
                    <button onClick={toggleCamera} disabled={!isCamAvailable} className={`w-12 h-12 rounded-full flex items-center justify-center backdrop-blur-sm transition-colors ${!isCamAvailable ? 'bg-red-600/50 cursor-not-allowed' : isCameraOff ? 'bg-rose-600' : 'bg-black/40'}`}>
                        <Icon name={!isCamAvailable || isCameraOff ? 'video-camera-slash' : 'video-camera'} className="w-6 h-6" />
                    </button>
                    <button onClick={handleHangUp} className="w-12 h-12 bg-red-600 rounded-full flex items-center justify-center">
                         <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" transform="rotate(-135 12 12)"/></svg>
                    </button>
                </div>
            </footer>
        </div>
    );
};

export default LiveVideoRoomScreen;