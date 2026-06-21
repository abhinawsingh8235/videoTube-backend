import mongoose, { isValidObjectId } from "mongoose"
import { Playlist } from "../models/playlist.model.js"
import { Video } from "../models/video.model.js"
import { ApiError } from "../utils/ApiError.js"
import { ApiResponse } from "../utils/ApiResponse.js"
import { asyncHandler } from "../utils/asyncHandler.js"

// ─── 1. CREATE PLAYLIST ───────────────────────────────────────────────────────
// POST /api/v1/playlists
const createPlaylist = asyncHandler(async (req, res) => {
    const { name, description } = req.body

    if (!name?.trim()) {
        throw new ApiError(400, "Playlist name is required")
    }

    if (!description?.trim()) {
        throw new ApiError(400, "Playlist description is required")
    }

    const playlist = await Playlist.create({
        name: name.trim(),
        description: description.trim(),
        owner: req.user._id,
        videos: [],
    })

    if (!playlist) {
        throw new ApiError(500, "Failed to create playlist, please try again")
    }

    return res
        .status(201)
        .json(new ApiResponse(201, playlist, "Playlist created successfully"))
})

// ─── 2. GET ALL PLAYLISTS OF A USER ──────────────────────────────────────────
// GET /api/v1/playlists/user/:userId
const getUserPlaylists = asyncHandler(async (req, res) => {
    const { userId } = req.params

    if (!isValidObjectId(userId)) {
        throw new ApiError(400, "Invalid userId")
    }

    const playlists = await Playlist.aggregate([
        // Stage 1: is user ki saari playlists
        {
            $match: {
                owner: new mongoose.Types.ObjectId(userId),
            },
        },
        // Stage 2: har playlist mein kitne videos hain + first video ka thumbnail
        {
            $lookup: {
                from: "videos",
                localField: "videos",
                foreignField: "_id",
                as: "videos",
                pipeline: [
                    { $match: { isPublished: true } },
                    {
                        $project: {
                            thumbnail: 1,
                            title: 1,
                        },
                    },
                ],
            },
        },
        // Stage 3: useful fields add karo
        {
            $addFields: {
                videosCount: { $size: "$videos" },
                // Playlist ka cover = pehle video ka thumbnail
                coverImage: { $first: "$videos.thumbnail" },
            },
        },
        // Stage 4: videos array hatao — yahan sirf count chahiye
        {
            $project: {
                name: 1,
                description: 1,
                owner: 1,
                videosCount: 1,
                coverImage: 1,
                createdAt: 1,
                updatedAt: 1,
            },
        },
        // Stage 5: newest playlist pehle
        {
            $sort: { createdAt: -1 },
        },
    ])

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                playlists,
                "User playlists fetched successfully"
            )
        )
})

// ─── 3. GET PLAYLIST BY ID ────────────────────────────────────────────────────
// GET /api/v1/playlists/:playlistId
const getPlaylistById = asyncHandler(async (req, res) => {
    const { playlistId } = req.params

    if (!isValidObjectId(playlistId)) {
        throw new ApiError(400, "Invalid playlistId")
    }

    const playlist = await Playlist.aggregate([
        // Stage 1: is playlist ko match karo
        {
            $match: {
                _id: new mongoose.Types.ObjectId(playlistId),
            },
        },
        // Stage 2: owner ki details populate karo
        {
            $lookup: {
                from: "users",
                localField: "owner",
                foreignField: "_id",
                as: "owner",
                pipeline: [
                    {
                        $project: {
                            username: 1,
                            avatar: 1,
                            fullName: 1,
                        },
                    },
                ],
            },
        },
        {
            $addFields: {
                owner: { $first: "$owner" },
            },
        },
        // Stage 3: videos array ke har video ki full details laao
        {
            $lookup: {
                from: "videos",
                localField: "videos",
                foreignField: "_id",
                as: "videos",
                pipeline: [
                    // Sirf published videos
                    { $match: { isPublished: true } },
                    // Har video ka owner bhi populate karo
                    {
                        $lookup: {
                            from: "users",
                            localField: "owner",
                            foreignField: "_id",
                            as: "owner",
                            pipeline: [
                                {
                                    $project: {
                                        username: 1,
                                        avatar: 1,
                                        fullName: 1,
                                    },
                                },
                            ],
                        },
                    },
                    {
                        $addFields: { owner: { $first: "$owner" } },
                    },
                    {
                        $project: {
                            videoFile: 1,
                            thumbnail: 1,
                            title: 1,
                            description: 1,
                            duration: 1,
                            views: 1,
                            owner: 1,
                            createdAt: 1,
                        },
                    },
                ],
            },
        },
        // Stage 4: total videos count add karo
        {
            $addFields: {
                videosCount: { $size: "$videos" },
                totalViews: { $sum: "$videos.views" },
            },
        },
    ])

    if (!playlist?.length) {
        throw new ApiError(404, "Playlist not found")
    }

    return res
        .status(200)
        .json(
            new ApiResponse(200, playlist[0], "Playlist fetched successfully")
        )
})

// ─── 4. ADD VIDEO TO PLAYLIST ─────────────────────────────────────────────────
// PATCH /api/v1/playlists/add/:videoId/:playlistId
const addVideoToPlaylist = asyncHandler(async (req, res) => {
    const { playlistId, videoId } = req.params

    if (!isValidObjectId(playlistId)) {
        throw new ApiError(400, "Invalid playlistId")
    }
    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid videoId")
    }

    // Playlist aur video dono exist karte hain ya nahi
    const playlist = await Playlist.findById(playlistId)
    if (!playlist) {
        throw new ApiError(404, "Playlist not found")
    }

    const video = await Video.findById(videoId)
    if (!video) {
        throw new ApiError(404, "Video not found")
    }

    // Sirf owner hi video add kar sakta hai
    if (playlist.owner.toString() !== req.user._id.toString()) {
        throw new ApiError(403, "You are not allowed to modify this playlist")
    }

    // Video already playlist mein hai ya nahi
    if (playlist.videos.includes(videoId)) {
        throw new ApiError(400, "Video is already in the playlist")
    }

    const updatedPlaylist = await Playlist.findByIdAndUpdate(
        playlistId,
        { $push: { videos: videoId } }, // $push se array mein add hota hai
        { new: true }
    )

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                updatedPlaylist,
                "Video added to playlist successfully"
            )
        )
})

// ─── 5. REMOVE VIDEO FROM PLAYLIST ───────────────────────────────────────────
// PATCH /api/v1/playlists/remove/:videoId/:playlistId
const removeVideoFromPlaylist = asyncHandler(async (req, res) => {
    const { playlistId, videoId } = req.params

    if (!isValidObjectId(playlistId)) {
        throw new ApiError(400, "Invalid playlistId")
    }
    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid videoId")
    }

    const playlist = await Playlist.findById(playlistId)
    if (!playlist) {
        throw new ApiError(404, "Playlist not found")
    }

    const video = await Video.findById(videoId)
    if (!video) {
        throw new ApiError(404, "Video not found")
    }

    // Sirf owner hi video remove kar sakta hai
    if (playlist.owner.toString() !== req.user._id.toString()) {
        throw new ApiError(403, "You are not allowed to modify this playlist")
    }

    // Video playlist mein hai ya nahi
    if (!playlist.videos.includes(videoId)) {
        throw new ApiError(400, "Video is not in the playlist")
    }

    const updatedPlaylist = await Playlist.findByIdAndUpdate(
        playlistId,
        { $pull: { videos: new mongoose.Types.ObjectId(videoId) } }, // $pull se array se remove hota hai
        { new: true }
    )

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                updatedPlaylist,
                "Video removed from playlist successfully"
            )
        )
})

// ─── 6. DELETE PLAYLIST ───────────────────────────────────────────────────────
// DELETE /api/v1/playlists/:playlistId
const deletePlaylist = asyncHandler(async (req, res) => {
    const { playlistId } = req.params

    if (!isValidObjectId(playlistId)) {
        throw new ApiError(400, "Invalid playlistId")
    }

    const playlist = await Playlist.findById(playlistId)
    if (!playlist) {
        throw new ApiError(404, "Playlist not found")
    }

    // Sirf owner hi delete kar sakta hai
    if (playlist.owner.toString() !== req.user._id.toString()) {
        throw new ApiError(403, "You are not allowed to delete this playlist")
    }

    await Playlist.findByIdAndDelete(playlistId)

    return res
        .status(200)
        .json(
            new ApiResponse(200, { playlistId }, "Playlist deleted successfully")
        )
})

// ─── 7. UPDATE PLAYLIST ───────────────────────────────────────────────────────
// PATCH /api/v1/playlists/:playlistId
const updatePlaylist = asyncHandler(async (req, res) => {
    const { playlistId } = req.params
    const { name, description } = req.body

    if (!isValidObjectId(playlistId)) {
        throw new ApiError(400, "Invalid playlistId")
    }

    if (!name?.trim() && !description?.trim()) {
        throw new ApiError(400, "Provide at least name or description to update")
    }

    const playlist = await Playlist.findById(playlistId)
    if (!playlist) {
        throw new ApiError(404, "Playlist not found")
    }

    // Sirf owner hi update kar sakta hai
    if (playlist.owner.toString() !== req.user._id.toString()) {
        throw new ApiError(403, "You are not allowed to update this playlist")
    }

    const updateFields = {}
    if (name?.trim()) updateFields.name = name.trim()
    if (description?.trim()) updateFields.description = description.trim()

    const updatedPlaylist = await Playlist.findByIdAndUpdate(
        playlistId,
        { $set: updateFields },
        { new: true }
    )

    return res
        .status(200)
        .json(
            new ApiResponse(
                200,
                updatedPlaylist,
                "Playlist updated successfully"
            )
        )
})

export {
    createPlaylist,
    getUserPlaylists,
    getPlaylistById,
    addVideoToPlaylist,
    removeVideoFromPlaylist,
    deletePlaylist,
    updatePlaylist,
}