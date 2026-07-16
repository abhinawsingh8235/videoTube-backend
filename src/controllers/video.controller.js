import mongoose, { isValidObjectId } from "mongoose"
import { Video } from "../models/video.model.js"
import { User } from "../models/user.model.js"
import { ApiError } from "../utils/ApiError.js"
import { ApiResponse } from "../utils/ApiResponse.js"
import { asyncHandler } from "../utils/asyncHandler.js"
import { uploadOnCloudinary } from "../utils/cloudinary.js"

// ─── Helper: delete file from Cloudinary ─────────────────────────────────────
// The base cloudinary.js util only has upload. We add a small delete helper here
// so we can clean up old thumbnails / videos when they are replaced or deleted.
import { v2 as cloudinary } from "cloudinary"

const deleteFromCloudinary = async (publicUrlOrId, resourceType = "image") => {
    try {
        if (!publicUrlOrId) return null

        // If a full URL was stored, extract the public_id from it
        // e.g. https://res.cloudinary.com/demo/video/upload/v1234/abc.mp4  → "abc"
        let publicId = publicUrlOrId
        if (publicUrlOrId.includes("cloudinary.com")) {
            // Strip everything before the last segment (after /upload/vXXXXXX/)
            const parts = publicUrlOrId.split("/")
            const fileWithExt = parts[parts.length - 1]          // "abc.mp4"
            publicId = fileWithExt.replace(/\.[^/.]+$/, "")       // "abc"
        }

        const result = await cloudinary.uploader.destroy(publicId, {
            resource_type: resourceType,
        })
        return result
    } catch (error) {
        console.error("Cloudinary delete error:", error)
        return null
    }
}

// ─── 1. GET ALL VIDEOS ────────────────────────────────────────────────────────
// GET /api/v1/videos?page=1&limit=10&query=&sortBy=createdAt&sortType=desc&userId=
const getAllVideos = asyncHandler(async (req, res) => {
    const {
        page = 1,
        limit = 10,
        query,       // search string matched against title/description
        sortBy = "createdAt",
        sortType = "desc",
        userId,      // filter by a specific owner
    } = req.query

    // Build the aggregation pipeline
    const pipeline = []

    // Stage 1 — filter by owner if userId is provided
    if (userId) {
        if (!isValidObjectId(userId)) {
            throw new ApiError(400, "Invalid userId")
        }
        pipeline.push({
            $match: { owner: new mongoose.Types.ObjectId(userId) },
        })
    }

    // Stage 2 — text search on title / description if query is provided
    if (query) {
        pipeline.push({
            $match: {
                $or: [
                    { title: { $regex: query, $options: "i" } },
                    { description: { $regex: query, $options: "i" } },
                ],
            },
        })
    }

    // Stage 3 — only show published videos (unless the owner is requesting)
    pipeline.push({ $match: { isPublished: true } })

    // Stage 4 — sort
    const sortOrder = sortType === "asc" ? 1 : -1
    pipeline.push({ $sort: { [sortBy]: sortOrder } })

    // Stage 5 — populate owner info (username + avatar only)
    pipeline.push(
        {
            $lookup: {
                from: "users",
                localField: "owner",
                foreignField: "_id",
                as: "owner",
                pipeline: [
                    { $project: { username: 1, avatar: 1, fullName: 1 } },
                ],
            },
        },
        {
            $addFields: { owner: { $first: "$owner" } },
        }
    )

    // mongoose-aggregate-paginate-v2 handles LIMIT / SKIP for us
    const options = {
        page: parseInt(page, 10),
        limit: parseInt(limit, 10),
    }

    const result = await Video.aggregatePaginate(
        Video.aggregate(pipeline),
        options
    )

    return res
        .status(200)
        .json(new ApiResponse(200, result, "Videos fetched successfully"))
})

// ─── 2. PUBLISH A VIDEO ───────────────────────────────────────────────────────
// POST /api/v1/videos  (multipart: videoFile + thumbnail)
const publishAVideo = asyncHandler(async (req, res) => {
    const { title, description } = req.body

    // Validate required text fields
    if (!title?.trim() || !description?.trim()) {
        throw new ApiError(400, "Title and description are required")
    }

    // Check files were uploaded by multer
    const videoLocalPath = req.files?.videoFile?.[0]?.path
    const thumbnailLocalPath = req.files?.thumbnail?.[0]?.path

    if (!videoLocalPath) {
        throw new ApiError(400, "Video file is required")
    }
    if (!thumbnailLocalPath) {
        throw new ApiError(400, "Thumbnail is required")
    }

    // Upload both files to Cloudinary
    const videoFile = await uploadOnCloudinary(videoLocalPath)
    const thumbnail = await uploadOnCloudinary(thumbnailLocalPath)

    if (!videoFile?.url) {
        throw new ApiError(500, "Error uploading video to Cloudinary")
    }
    if (!thumbnail?.url) {
        throw new ApiError(500, "Error uploading thumbnail to Cloudinary")
    }

    // Create DB record
    // videoFile.duration is returned by Cloudinary for video uploads (in seconds)
    const video = await Video.create({
        videoFile: videoFile.url,
        thumbnail: thumbnail.url,
        title: title.trim(),
        description: description.trim(),
        duration: videoFile.duration ?? 0,
        owner: req.user._id,
        isPublished: true,
    })

    const createdVideo = await Video.findById(video._id).populate(
        "owner",
        "username avatar fullName"
    )

    if (!createdVideo) {
        throw new ApiError(500, "Something went wrong while saving the video")
    }

    return res
        .status(201)
        .json(new ApiResponse(201, createdVideo, "Video published successfully"))
})

// ─── 3. GET VIDEO BY ID ───────────────────────────────────────────────────────
// GET /api/v1/videos/:videoId
const getVideoById = asyncHandler(async (req, res) => {
    const { videoId } = req.params

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid videoId")
    }

    // Use aggregation to also get owner details and like count in one query
    const video = await Video.aggregate([
        {
            $match: { _id: new mongoose.Types.ObjectId(videoId) },
        },
        // Populate owner
        {
            $lookup: {
                from: "users",
                localField: "owner",
                foreignField: "_id",
                as: "owner",
                pipeline: [
                    { $project: { username: 1, avatar: 1, fullName: 1 } },
                ],
            },
        },
        { $addFields: { owner: { $first: "$owner" } } },
        // Count likes for this video
        {
            $lookup: {
                from: "likes",
                localField: "_id",
                foreignField: "video",
                as: "likes",
            },
        },
        {
            $addFields: {
                likesCount: { $size: "$likes" },
                // isLiked: {
                //     $cond: {
                //         if: { $in: [req.user._id, "$likes.likedBy"] },
                //         then: true,
                //         else: false,
                //     },
                // },
                isLiked: {
                    $cond: {
                        if: {
                            $and: [
                                { $ne: [req.user?._id, null] },
                                { $in: [req.user?._id, "$likes.likedBy"] }
                            ]
                        },
                        then: true,
                        else: false,
                    },
                },
            },
        },
        {
            $project: { likes: 0 }, // remove the full likes array, keep only count
        },
    ])

    if (!video?.length) {
        throw new ApiError(404, "Video not found")
    }

    // Increment view count
    await Video.findByIdAndUpdate(videoId, { $inc: { views: 1 } })

    // Add to logged-in user's watch history
    if (req.user?._id) {
        await User.findByIdAndUpdate(req.user._id, {
            $addToSet: {
                watchHistory: videoId,
            },
        })
    }

    return res
        .status(200)
        .json(new ApiResponse(200, video[0], "Video fetched successfully"))
})

// ─── 4. UPDATE VIDEO ──────────────────────────────────────────────────────────
// PATCH /api/v1/videos/:videoId  (optional: new thumbnail file)
const updateVideo = asyncHandler(async (req, res) => {
    const { videoId } = req.params
    const { title, description } = req.body

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid videoId")
    }

    // At least one field must be provided
    if (!title?.trim() && !description?.trim() && !req.file) {
        throw new ApiError(400, "Provide at least one field to update")
    }

    // Fetch existing video and check ownership
    const existingVideo = await Video.findById(videoId)
    if (!existingVideo) {
        throw new ApiError(404, "Video not found")
    }

    if (existingVideo.owner.toString() !== req.user._id.toString()) {
        throw new ApiError(403, "You are not allowed to update this video")
    }

    // Build update object
    const updateFields = {}
    if (title?.trim()) updateFields.title = title.trim()
    if (description?.trim()) updateFields.description = description.trim()

    // Handle thumbnail replacement
    if (req.file?.path) {
        const newThumbnail = await uploadOnCloudinary(req.file.path)
        if (!newThumbnail?.url) {
            throw new ApiError(500, "Error uploading new thumbnail")
        }

        // Delete old thumbnail from Cloudinary
        await deleteFromCloudinary(existingVideo.thumbnail, "image")

        updateFields.thumbnail = newThumbnail.url
    }

    const updatedVideo = await Video.findByIdAndUpdate(
        videoId,
        { $set: updateFields },
        { new: true }
    ).populate("owner", "username avatar fullName")

    return res
        .status(200)
        .json(new ApiResponse(200, updatedVideo, "Video updated successfully"))
})

// ─── 5. DELETE VIDEO ──────────────────────────────────────────────────────────
// DELETE /api/v1/videos/:videoId
const deleteVideo = asyncHandler(async (req, res) => {
    const { videoId } = req.params

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid videoId")
    }

    const video = await Video.findById(videoId)
    if (!video) {
        throw new ApiError(404, "Video not found")
    }

    if (video.owner.toString() !== req.user._id.toString()) {
        throw new ApiError(403, "You are not allowed to delete this video")
    }

    // Delete video file and thumbnail from Cloudinary
    await deleteFromCloudinary(video.videoFile, "video")
    await deleteFromCloudinary(video.thumbnail, "image")

    // Delete the DB document
    await Video.findByIdAndDelete(videoId)

    // Optional cleanup: remove this video from all playlists, likes, comments
    // (import those models if you want to enable this)
    // await Like.deleteMany({ video: videoId })
    // await Comment.deleteMany({ video: videoId })

    return res
        .status(200)
        .json(new ApiResponse(200, { videoId }, "Video deleted successfully"))
})

// ─── 6. TOGGLE PUBLISH STATUS ─────────────────────────────────────────────────
// PATCH /api/v1/videos/toggle/publish/:videoId
const togglePublishStatus = asyncHandler(async (req, res) => {
    const { videoId } = req.params

    if (!isValidObjectId(videoId)) {
        throw new ApiError(400, "Invalid videoId")
    }

    const video = await Video.findById(videoId)
    if (!video) {
        throw new ApiError(404, "Video not found")
    }

    if (video.owner.toString() !== req.user._id.toString()) {
        throw new ApiError(403, "You are not allowed to modify this video")
    }

    // Flip the boolean
    video.isPublished = !video.isPublished
    await video.save({ validateBeforeSave: false })

    return res.status(200).json(
        new ApiResponse(
            200,
            { isPublished: video.isPublished },
            `Video ${video.isPublished ? "published" : "unpublished"} successfully`
        )
    )
})

export {
    getAllVideos,
    publishAVideo,
    getVideoById,
    updateVideo,
    deleteVideo,
    togglePublishStatus,
}